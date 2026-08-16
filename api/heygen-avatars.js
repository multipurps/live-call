// Lists the signed-in user's own avatars from LiveAvatar (HeyGen's real-time avatar
// product, now a separate platform from the old HeyGen Interactive Avatar API - it
// has its own key, from app.liveavatar.com/developers). The key comes from the
// signed-in user's own settings (stored in Supabase, sent by the client on each
// request) - not a shared Vercel environment variable, so every user burns their
// own LiveAvatar credits, never the app owner's.
export default async function handler(req, res) {
  const apiKey = req.headers['x-heygen-key'];
  if (!apiKey) return res.status(400).json({ error: 'No LiveAvatar API key set. Add yours in Profile settings.' });

  try {
    const r = await fetch('https://api.liveavatar.com/v1/avatars?page=1&page_size=100', {
      headers: { 'X-API-KEY': apiKey },
    });
    const raw = await r.text();
    let data;
    try { data = JSON.parse(raw); }
    catch {
      return res.status(502).json({
        error: `LiveAvatar returned a non-JSON response (status ${r.status}). This usually means your LiveAvatar API key is invalid. Raw response: ${raw.slice(0, 200)}`
      });
    }
    if (!r.ok) return res.status(r.status).json({ error: data });
    const results = data.data?.results || [];
    const avatars = results.map(a => ({ id: a.id, name: a.name || a.id }));
    return res.status(200).json({ avatars });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
}
