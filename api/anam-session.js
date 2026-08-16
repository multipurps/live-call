// Mints a short-lived Anam session token for the signed-in user's own avatar and
// system prompt. The API key comes from the user's own saved settings (sent by the
// client on each request) - never a shared Vercel env var - so every user burns their
// own Anam credits.
//
// voiceId/llmId use Anam's published defaults (Cara's voice, GPT-4.1 Mini) since the
// avatar list endpoint doesn't expose a matching default voice per avatar.
const DEFAULT_VOICE_ID = '6bfbe25a-979d-40f3-a92b-5394170af54b';
const DEFAULT_LLM_ID = '0934d97d-0c3a-4f33-91b0-5e136a0ef466';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const apiKey = req.headers['x-anam-key'];
  if (!apiKey) return res.status(400).json({ error: 'No Anam API key set. Add yours in Profile settings.' });

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
