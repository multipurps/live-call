// Mints a short-lived HeyGen streaming session token.
// HEYGEN_API_KEY must be set as a Vercel environment variable — never sent to the browser.
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const apiKey = process.env.HEYGEN_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'HEYGEN_API_KEY not set on server' });

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
        error: `HeyGen returned a non-JSON response (status ${r.status}). This usually means HEYGEN_API_KEY is missing, invalid, or lacks streaming access on Vercel. Raw response: ${raw.slice(0, 200)}`
      });
    }
    if (!r.ok) return res.status(r.status).json({ error: data });
    return res.status(200).json({ token: data.data.token });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
}
