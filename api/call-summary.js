import { createClient } from '@supabase/supabase-js';
import webpush from 'web-push';
import { getProviderKey } from '../lib/keys.js';

// Called right when a call ends. Deliberately does not take a session id from
// the client - the session-token response doesn't hand one back, so instead
// we ask Anam for this user's most recent session right after the call ends.
// Safe because each user has their own Anam key/account, so "most recent
// session on this key" is this call, not another user's.
async function findJustEndedSessionId(apiKey) {
  const resp = await fetch('https://api.anam.ai/v1/sessions?perPage=5&page=1', {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!resp.ok) return null;
  const body = await resp.json();
  const sessions = body?.data || [];
  if (!sessions.length) return null;
  // Assume list is most-recent-first (standard REST convention); if Anam ever
  // changes that, sort defensively by any timestamp field present.
  const sorted = [...sessions].sort((a, b) => {
    const at = new Date(a.startTime || a.createdAt || 0).getTime();
    const bt = new Date(b.startTime || b.createdAt || 0).getTime();
    return bt - at;
  });
  return sorted[0]?.id || null;
}

// The transcript isn't ready the instant a call ends - Anam finishes
// generating the session report a few seconds after CONNECTION_CLOSED fires.
// Poll with backoff instead of a single fetch.
async function pollTranscript(apiKey, sessionId, maxAttempts = 8, delayMs = 3000) {
  for (let i = 0; i < maxAttempts; i++) {
    const resp = await fetch(`https://api.anam.ai/v1/sessions/${sessionId}/transcript`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (resp.ok) {
      const data = await resp.json();
      if (data?.transcript?.length || Array.isArray(data) && data.length) return data;
    }
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return null;
}

function transcriptToText(transcript) {
  const turns = transcript?.transcript || transcript || [];
  return turns
    .map((t) => `${t.role === 'user' ? 'Caller' : 'Persona'}: ${t.content || t.text || ''}`)
    .join('\n');
}

async function summarize(transcriptText) {
  const apiKey = process.env.GROQ_API_KEY;
  const systemPrompt = `You just finished a live call as an AI persona. Write a short natural summary of
the call for the person who set up the call to read afterward - the same tone Mitra uses: warm, plain
language, first-person ("I called X, we talked about..."). Cover: who was called (if named), what was
discussed, anything the other person shared that's worth remembering (mood, news, requests), and how
the call ended. 2-4 sentences. No headers, no bullet points, just a short natural paragraph.`;
  const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: 'openai/gpt-oss-120b',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: transcriptText || '(No speech was captured on this call.)' },
      ],
      temperature: 0.6,
      max_completion_tokens: 300,
    }),
  });
  const data = await r.json();
  return data?.choices?.[0]?.message?.content?.trim() || 'Call ended - no summary could be generated.';
}

// Sync step: fold anything durable from this call into the persona's
// standing memory of this person (see sql/008_avatar_memory.sql and
// api/anam.js's prefetch on the next call). The model gets the EXISTING
// memory alongside the new transcript and returns the merged, deduplicated
// result - this is what keeps it from growing forever the way a plain
// append would; each call is a chance to consolidate, not just add.
async function extractMemory(transcriptText, existingFacts) {
  if (!transcriptText) return existingFacts; // nothing new to learn from a silent/failed call
  const apiKey = process.env.GROQ_API_KEY;
  const systemPrompt = `You maintain a persona's standing memory of one specific person across calls.
Given the EXISTING memory (may be empty) and a NEW call transcript, output the updated memory: merge in
any new durable facts (their name, preferences, ongoing situations, things they care about, recurring
topics), and drop anything that was clearly one-off or no longer relevant. Keep it as short plain
bullet points - facts only, no commentary, no "the caller said". If nothing durable came up this call,
just return the existing memory unchanged. Output ONLY the bullet list, nothing else.`;
  const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: 'openai/gpt-oss-120b',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `EXISTING MEMORY:\n${existingFacts || '(none yet)'}\n\nNEW TRANSCRIPT:\n${transcriptText}` },
      ],
      temperature: 0.3,
      max_completion_tokens: 500,
    }),
  });
  const data = await r.json();
  return data?.choices?.[0]?.message?.content?.trim() || existingFacts;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const vapidPublic = process.env.VAPID_PUBLIC_KEY;
  const vapidPrivate = process.env.VAPID_PRIVATE_KEY;
  const vapidSubject = process.env.VAPID_SUBJECT;
  if (!serviceKey) return res.status(500).json({ error: 'Server not configured' });

  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Missing auth token' });

  const supabase = createClient('https://ewgtpxomgkpbmfyddypw.supabase.co', serviceKey);
  const { data: userData, error: userErr } = await supabase.auth.getUser(token);
  if (userErr || !userData?.user) return res.status(401).json({ error: 'Invalid session' });
  const userId = userData.user.id;

  const { historyId } = req.body || {};
  if (!historyId) return res.status(400).json({ error: 'historyId required' });

  const anamKey = await getProviderKey(supabase, userId, 'anam');
  if (!anamKey) return res.status(400).json({ error: 'No Anam key on file for this user' });

  const sessionId = await findJustEndedSessionId(anamKey);
  if (!sessionId) return res.status(200).json({ summary: null, reason: 'No recent session found' });

  const transcript = await pollTranscript(anamKey, sessionId);
  const transcriptText = transcriptToText(transcript);
  const summary = await summarize(transcriptText);

  // Sync: merge whatever's durable from this call into standing memory,
  // so the next call (see api/anam.js's prefetch) starts already knowing it.
  const { data: memRow } = await supabase.from('avatar_memory').select('facts').eq('user_id', userId).maybeSingle();
  const updatedFacts = await extractMemory(transcriptText, memRow?.facts || '');
  if (updatedFacts !== (memRow?.facts || '')) {
    await supabase.from('avatar_memory').upsert({ user_id: userId, facts: updatedFacts, updated_at: new Date().toISOString() });
  }

  const { error: updateErr } = await supabase
    .from('video_call_history')
    .update({ summary })
    .eq('id', historyId)
    .eq('user_id', userId); // scope the update to this user's own row, never trust historyId alone
  if (updateErr) return res.status(500).json({ error: updateErr.message });

  // Push regardless of whether the requester's tab/app is even still open -
  // this is the actual delivery guarantee, not the HTTP response below.
  if (vapidPublic && vapidPrivate && vapidSubject) {
    webpush.setVapidDetails(vapidSubject, vapidPublic, vapidPrivate);
    const { data: subs } = await supabase.from('push_subscriptions').select('*').eq('user_id', userId);
    const payload = JSON.stringify({ title: 'Call summary', body: summary });
    await Promise.all((subs || []).map(async (sub) => {
      try {
        await webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, payload);
      } catch (err) {
        if (err.statusCode === 410 || err.statusCode === 404) {
          await supabase.from('push_subscriptions').delete().eq('id', sub.id);
        }
      }
    }));
  }

  return res.status(200).json({ summary });
}
