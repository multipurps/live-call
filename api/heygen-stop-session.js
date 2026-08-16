// Stops a LiveAvatar session on call end so the user's session (and billing) actually
// closes instead of idling out. Best-effort - called from the client's endCall() cleanup.
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const apiKey = req.headers['x-heygen-key'];
  if (!apiKey) return res.status(400).json({ error: 'No LiveAvatar API key set.' });

  const { sessionId } = req.body || {};
  if (!sessionId) return res.status(400).json({ error: 'sessionId is required' });

  try {
    const r = await fetch('https://api.liveavatar.com/v1/sessions/stop', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-KEY': apiKey },
      body: JSON.stringify({ session_id: sessionId, reason: 'USER_CLOSED' }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) return res.status(r.status).json({ error: data });
    return res.status(200).json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
}
