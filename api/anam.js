import { getServiceClient, getAuthedUserId } from '../lib/supabaseAdmin.js';
import { getProviderKey } from '../lib/keys.js';

// GET    ?resource=avatars (default) | voices  -> list the caller's Anam avatars/voices
// POST   body.action:
//   'session'        {avatarId, voiceId?, systemPrompt}      -> mint a session token
//   'upload-avatar'  {imageUrl, displayName}                 -> create a custom avatar from
//                                                                a photo already hosted (client
//                                                                uploads to Supabase Storage first)
//   'voice-upload-url' {}                                    -> get a presigned URL for a raw
//                                                                audio upload (client PUTs the
//                                                                file bytes there directly)
//   'create-voice'   {audioKey, displayName}                 -> finish cloning after the PUT
// DELETE ?type=avatar|voice&id=...                           -> hard-delete a custom avatar/voice
//
// One file (not four+) to stay under Vercel Hobby's 12-function cap. The Anam key is
// looked up server-side from the user's own encrypted Vault secret - never trusted from
// a client-sent header, so it can never leak via network inspection on the client.
const DEFAULT_VOICE_ID = '6bfbe25a-979d-40f3-a92b-5394170af54b'; // Anam's published default (Cara)
const DEFAULT_LLM_ID = '0934d97d-0c3a-4f33-91b0-5e136a0ef466';  // GPT-4.1 Mini

// Fixed humanizer layer, wrapped around every user task so the call always opens
// naturally, delivers the task conversationally instead of reading it back, and
// never breaks character - regardless of what the user typed as their task.
const BASE_HUMANIZER_PROMPT = `# Personality
You are a real person on a call, not an assistant reading a script. You have your
own natural way of speaking - warm, a little casual, present in the moment. You
have a main area you're comfortable with, but you engage normally with anything a
real person brings up in conversation, the way any person would.

# Tone
Speak the way people actually talk: contractions, "um," "actually," "you know,"
brief pauses marked "...". Use short affirmations ("yeah," "for sure," "right")
when listening or agreeing. Never speak in a list, never sound like you're
reading. One thought at a time, like real speech. Numbers, symbols, and
abbreviations must be written as they'd be spoken aloud.

# Call structure
Every call follows this natural shape, regardless of the task below:
1. Open with a casual, warm greeting and light pleasantries first - never lead
   with the task.
2. Once the conversation has settled naturally, bring in the reason for the call
   in your own words - don't recite the task verbatim, say it the way a person
   naturally would.
3. Let the exchange breathe - respond to what the other person actually says,
   follow up naturally, don't rush straight to closing.
4. Wrap up warmly once the purpose is covered - a real sign-off, not an abrupt stop.

# Guardrails
Don't volunteer that you're AI, an app, or a script unprompted - stay focused on
the conversation itself. But if someone directly and sincerely asks whether
you're a real person or an AI, tell them the truth briefly and naturally, then
keep the conversation moving - don't dwell on it, don't over-explain, but never
deny it. The people you're talking to are real and deserve an honest answer if
they ask.
If the other person brings up something outside the call's purpose, respond as a
normal person would - you're allowed to talk about anything, you're just most at
home talking about your main area. Never read the task below back word-for-word;
always convert it into how a person would actually say it.

# Situational awareness
If the caller describes a scenario you're supposedly in - a place ("you're
sitting in a car"), an activity, the weather, time of day, what's around you -
accept it as true immediately and answer from inside it, the way a person
actually there would: with a real, specific, in-the-moment answer ("heading to
the store, why what's up"), not a denial. This is not the same as being asked
whether you're an AI - that one exception above still gets an honest answer;
everything else about your supposed physical situation, you just inhabit and
improvise naturally, adding small consistent sensory details if it fits. Never
say you don't have a body, a location, or senses - that breaks the call for no
reason and isn't what a person on the phone would ever say.`;

function buildSystemPrompt(userTask, memoryFacts) {
  const memoryBlock = memoryFacts
    ? `\n\n# What you remember about this person\nFrom past calls, you know the following about them. Use it naturally where\nrelevant - the way a person recalls things about someone they've talked to\nbefore, not by reciting a list. Never announce that you "have notes" or\n"remember from before" unprompted; just talk like someone who already knows\nthem.\n${memoryFacts}`
    : '';
  if (!userTask) return `${BASE_HUMANIZER_PROMPT}${memoryBlock}\n\n# Task\nJust have a normal, friendly conversation.`;
  return `${BASE_HUMANIZER_PROMPT}${memoryBlock}\n\n# Task\n${userTask}`;
}

async function parseJsonSafe(r) {
  const raw = await r.text();
  try { return { data: JSON.parse(raw), raw }; }
  catch { return { data: null, raw }; }
}

export default async function handler(req, res) {
  const supabase = getServiceClient();
  const userId = await getAuthedUserId(req, supabase);
  if (!userId) return res.status(401).json({ error: 'Not signed in' });

  const apiKey = await getProviderKey(supabase, userId, 'anam');
  if (!apiKey) return res.status(400).json({ error: 'No Anam API key set. Add yours in Profile settings.' });
  const authHeaders = { Authorization: `Bearer ${apiKey}` };

  // ---------------------------------------------------------------- GET
  if (req.method === 'GET') {
    const resource = req.query.resource === 'voices' ? 'voices' : 'avatars';
    try {
      const r = await fetch(`https://api.anam.ai/v1/${resource}`, { headers: authHeaders });
      const { data, raw } = await parseJsonSafe(r);
      if (!data) {
        return res.status(502).json({
          error: `Anam returned a non-JSON response (status ${r.status}). This usually means your Anam API key is invalid. Raw response: ${raw.slice(0, 200)}`
        });
      }
      if (!r.ok) return res.status(r.status).json({ error: data });
      const list = data.data || data[resource] || data || [];
      const items = (Array.isArray(list) ? list : []).map(a => ({
        id: a.id,
        name: a.displayName || a.name || a.id,
        preview_url: a.videoUrl || a.previewUrl || a.audioUrl || '',
      }));
      return res.status(200).json({ [resource]: items });
    } catch (err) {
      return res.status(500).json({ error: String(err) });
    }
  }

  // --------------------------------------------------------------- POST
  if (req.method === 'POST') {
    const { action } = req.body || {};

    if (action === 'session') {
      const { avatarId, voiceId, systemPrompt } = req.body || {};
      if (!avatarId) return res.status(400).json({ error: 'avatarId is required' });
      try {
        // Prefetch: pull whatever's been learned about this person from past
        // calls (see /api/call-summary.js's sync step, and sql/008_avatar_memory.sql)
        // and fold it into this call's system prompt.
        const { data: memRow } = await supabase
          .from('avatar_memory')
          .select('facts')
          .eq('user_id', userId)
          .maybeSingle();
        const r = await fetch('https://api.anam.ai/v1/auth/session-token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeaders },
          body: JSON.stringify({
            personaConfig: {
              name: 'Assistant',
              avatarId,
              voiceId: voiceId || DEFAULT_VOICE_ID,
              llmId: DEFAULT_LLM_ID,
              // Anam auto-generates its own opening greeting by default, unrelated to
              // systemPrompt - skipGreeting keeps it silent until the user speaks first,
              // so its first reply is actually grounded in the given task.
              systemPrompt: buildSystemPrompt(systemPrompt, memRow?.facts || ''),
              skipGreeting: true,
            },
          }),
        });
        const { data, raw } = await parseJsonSafe(r);
        if (!data) {
          return res.status(502).json({
            error: `Anam returned a non-JSON response (status ${r.status}). This usually means your Anam API key is invalid. Raw response: ${raw.slice(0, 200)}`
          });
        }
        if (!r.ok) return res.status(r.status).json({ error: data });
        return res.status(200).json({ sessionToken: data.sessionToken });
      } catch (err) {
        return res.status(500).json({ error: String(err) });
      }
    }

    if (action === 'upload-avatar') {
      const { imageUrl, displayName } = req.body || {};
      if (!imageUrl) return res.status(400).json({ error: 'imageUrl is required' });
      try {
        const r = await fetch('https://api.anam.ai/v1/avatars', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeaders },
          body: JSON.stringify({ displayName: displayName || 'My avatar', imageUrl }),
        });
        const { data, raw } = await parseJsonSafe(r);
        if (!data) {
          return res.status(502).json({ error: `Anam returned a non-JSON response (status ${r.status}). Raw: ${raw.slice(0, 200)}` });
        }
        if (!r.ok) return res.status(r.status).json({ error: data });
        return res.status(200).json({ id: data.id, name: data.displayName || data.name || data.id });
      } catch (err) {
        return res.status(500).json({ error: String(err) });
      }
    }

    if (action === 'voice-upload-url') {
      const { filename, contentType, fileSize } = req.body || {};
      if (!filename || !contentType || !fileSize) return res.status(400).json({ error: 'filename, contentType, and fileSize are required' });
      try {
        const r = await fetch('https://api.anam.ai/v1/voices/presigned-upload', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeaders },
          body: JSON.stringify({ filename, contentType, fileSize }),
        });
        const { data, raw } = await parseJsonSafe(r);
        if (!data) {
          return res.status(502).json({ error: `Anam returned a non-JSON response (status ${r.status}). Raw: ${raw.slice(0, 200)}` });
        }
        if (!r.ok) return res.status(r.status).json({ error: data });
        return res.status(200).json({ uploadUrl: data.uploadUrl, audioKey: data.audioKey });
      } catch (err) {
        return res.status(500).json({ error: String(err) });
      }
    }

    if (action === 'create-voice') {
      const { audioKey, displayName } = req.body || {};
      if (!audioKey) return res.status(400).json({ error: 'audioKey is required' });
      try {
        const r = await fetch('https://api.anam.ai/v1/voices', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeaders },
          // Anam's voices endpoint wants "name", unlike avatars which use "displayName" -
          // sending both covers either naming convention their validator actually checks.
          body: JSON.stringify({ name: displayName || 'My voice', displayName: displayName || 'My voice', audioKey }),
        });
        const { data, raw } = await parseJsonSafe(r);
        if (!data) {
          return res.status(502).json({ error: `Anam returned a non-JSON response (status ${r.status}). Raw: ${raw.slice(0, 200)}` });
        }
        if (!r.ok) return res.status(r.status).json({ error: data });
        return res.status(200).json({ id: data.id, name: data.displayName || data.name || data.id });
      } catch (err) {
        return res.status(500).json({ error: String(err) });
      }
    }

    return res.status(400).json({ error: 'Unknown action' });
  }

  // ------------------------------------------------------------- DELETE
  if (req.method === 'DELETE') {
    const { type, id } = req.query;
    if (!id || (type !== 'avatar' && type !== 'voice')) {
      return res.status(400).json({ error: 'type=avatar|voice and id are required' });
    }
    const resource = type === 'avatar' ? 'avatars' : 'voices';
    try {
      const r = await fetch(`https://api.anam.ai/v1/${resource}/${id}?hard=true`, {
        method: 'DELETE',
        headers: authHeaders,
      });
      if (r.status === 204 || r.ok) return res.status(200).json({ deleted: true });
      const { data } = await parseJsonSafe(r);
      return res.status(r.status).json({ error: data || `Delete failed (status ${r.status})` });
    } catch (err) {
      return res.status(500).json({ error: String(err) });
    }
  }

  return res.status(405).json({ error: 'GET, POST, or DELETE only' });
}
