// Mints a short-lived HeyGen streaming session token.
// The HeyGen API key comes from the signed-in user's own settings (stored in Supabase,
// sent by the client on each request) - NOT a shared Vercel environment variable. This
// means every user burns their own HeyGen credits, never the app owner's.
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const apiKey = req.headers['x-heygen-key'];
  if (!apiKey) return res.status(400).json({ error: 'No HeyGen API key set. Add yours in Profile settings.' });

  try {
    const r = await fetch('https://api.heygen.com/v1/streaming.create_token', {
      method: 'POST',
      headers: { 'x-api-key': apiKey },
    });
    const raw = await r.text();
    let data;
    try { data = JSON.parse(raw); }
    catch {
      return res.status(502).json({
        error: `HeyGen returned a non-JSON response (status ${r.status}). This usually means your HeyGen API key is invalid or lacks streaming access. Raw response: ${raw.slice(0, 200)}`
      });
    }
    if (!r.ok) return res.status(r.status).json({ error: data });
    return res.status(200).json({ token: data.data.token });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
}
