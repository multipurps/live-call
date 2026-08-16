// GET  -> lists the caller's available Anam avatars.
// POST -> mints a short-lived Anam session token for a chosen avatar + system prompt.
// Combined into one file (was two) to stay under Vercel Hobby's 12-serverless-function cap.
//
// The API key comes from the user's own saved settings (sent by the client on each
// request) - never a shared Vercel env var - so every user burns their own Anam credits.
const DEFAULT_VOICE_ID = '6bfbe25a-979d-40f3-a92b-5394170af54b'; // Anam's published default (Cara)
const DEFAULT_LLM_ID = '0934d97d-0c3a-4f33-91b0-5e136a0ef466';  // GPT-4.1 Mini

export default async function handler(req, res) {
  const apiKey = req.headers['x-anam-key'];
  if (!apiKey) return res.status(400).json({ error: 'No Anam API key set. Add yours in Profile settings.' });

  if (req.method === 'GET') {
    try {
      const r = await fetch('https://api.anam.ai/v1/avatars', {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      const raw = await r.text();
      let data;
      try { data = JSON.parse(raw); }
      catch {
        return res.status(502).json({
          error: `Anam returned a non-JSON response (status ${r.status}). This usually means your Anam API key is invalid. Raw response: ${raw.slice(0, 200)}`
        });
      }
      if (!r.ok) return res.status(r.status).json({ error: data });
      const list = data.data || data.avatars || data || [];
      const avatars = (Array.isArray(list) ? list : []).map(a => ({
        id: a.id,
        name: a.displayName || a.name || a.id,
        preview_url: a.videoUrl || a.previewUrl || '',
      }));
      return res.status(200).json({ avatars });
    } catch (err) {
      return res.status(500).json({ error: String(err) });
    }
  }

  if (req.method === 'POST') {
    const { avatarId, systemPrompt } = req.body || {};
    if (!avatarId) return res.status(400).json({ error: 'avatarId is required' });

    try {
      const r = await fetch('https://api.anam.ai/v1/auth/session-token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          personaConfig: {
            name: 'Assistant',
            avatarId,
            voiceId: DEFAULT_VOICE_ID,
            llmId: DEFAULT_LLM_ID,
            systemPrompt: systemPrompt || 'You are a helpful, friendly assistant on a live video call.',
          },
        }),
      });
      const raw = await r.text();
      let data;
      try { data = JSON.parse(raw); }
      catch {
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

  return res.status(405).json({ error: 'GET or POST only' });
}
