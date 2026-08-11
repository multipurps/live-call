export default async function handler(req, res) {
  const apiKey = process.env.HEYGEN_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'HEYGEN_API_KEY not set on server' });

  try {
    const r = await fetch('https://api.heygen.com/v1/streaming/avatar.list', {
      headers: { 'x-api-key': apiKey },
    });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: data });
    const avatars = (data.data || []).map(a => ({ id: a.avatar_id || a.id, name: a.pose_name || a.avatar_name || a.name || a.avatar_id || a.id }));
    return res.status(200).json({ avatars });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
}
