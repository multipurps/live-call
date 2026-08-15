export default async function handler(req, res) {
  const apiKey = process.env.HEYGEN_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'HEYGEN_API_KEY not set on server' });

  try {
    const r = await fetch('https://api.heygen.com/v1/streaming/avatar.list', {
      headers: { 'x-api-key': apiKey },
    });
    const raw = await r.text();
    let data;
    try { data = JSON.parse(raw); }
    catch {
      // HeyGen (or a proxy/WAF in front of it) returned something that isn't JSON at all -
      // almost always means the API key is invalid/expired/wrong-tier, not a code bug.
      return res.status(502).json({
        error: `HeyGen returned a non-JSON response (status ${r.status}). This usually means HEYGEN_API_KEY is missing, invalid, or lacks streaming access on Vercel. Raw response: ${raw.slice(0, 200)}`
      });
    }
    if (!r.ok) return res.status(r.status).json({ error: data });
    const avatars = (data.data || []).map(a => ({ id: a.avatar_id || a.id, name: a.pose_name || a.avatar_name || a.name || a.avatar_id || a.id }));
    return res.status(200).json({ avatars });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
}
