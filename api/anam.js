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
              systemPrompt: systemPrompt
                ? `You are on a live video call with one job: ${systemPrompt}. Stay focused on this the entire call - don't drift into unrelated small talk or generic chit-chat.`
                : 'You are a helpful, friendly assistant on a live video call.',
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
          body: JSON.stringify({ displayName: displayName || 'My voice', audioKey }),
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
