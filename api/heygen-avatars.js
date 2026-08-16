// Lists the signed-in user's own HeyGen avatars, using their own API key (sent from the
// client, sourced from their Supabase settings) - not a shared Vercel environment variable.
export default async function handler(req, res) {
  const apiKey = req.headers['x-heygen-key'];
  if (!apiKey) return res.status(400).json({ error: 'No HeyGen API key set. Add yours in Profile settings.' });

  try {
    const r = await fetch('https://api.heygen.com/v1/streaming/avatar.list', {
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
    const avatars = (data.data || []).map(a => ({ id: a.avatar_id || a.id, name: a.pose_name || a.avatar_name || a.name || a.avatar_id || a.id }));
    return res.status(200).json({ avatars });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
}
