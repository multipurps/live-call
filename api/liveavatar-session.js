export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const apiKey = process.env.LIVEAVATAR_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'LIVEAVATAR_API_KEY not set on server' });

  const { avatarId, voiceId, contextId, systemPrompt } = req.body || {};
  if (!avatarId) return res.status(400).json({ error: 'avatarId is required' });

  try {
    const tokenResp = await fetch('https://api.liveavatar.com/v1/sessions/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-KEY': apiKey },
      body: JSON.stringify({
        avatar_id: avatarId,
        avatar_persona: {
          voice_id: voiceId || undefined,
          context_id: contextId || undefined,
          language: 'en',
        },
        mode: 'FULL',
        is_sandbox: false,
        video_settings: { quality: 'high', encoding: 'H264' },
        interactivity_type: 'CONVERSATIONAL',
      }),
    });
    const tokenData = await tokenResp.json();
    if (!tokenResp.ok) return res.status(tokenResp.status).json({ error: tokenData, stage: 'token' });

    const sessionToken = tokenData.data?.session_token;
    const sessionId = tokenData.data?.session_id;

    const startResp = await fetch('https://api.liveavatar.com/v1/sessions/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${sessionToken}` },
      body: JSON.stringify({}),
    });
    const startData = await startResp.json();
    if (!startResp.ok) return res.status(startResp.status).json({ error: startData, stage: 'start' });

    return res.status(200).json({ sessionId, sessionToken, room: startData.data });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
}
