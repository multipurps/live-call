// Lists LiveAvatar's public avatar directory (avatars anyone can use, not just the
// ones already on the caller's account) so a user with no avatars of their own can
// still pick one to start a call. Same auth pattern as heygen-avatars.js: the caller's
// own LiveAvatar key is forwarded, sent by the client on each request.
export default async function handler(req, res) {
  const apiKey = req.headers['x-heygen-key'];
  if (!apiKey) return res.status(400).json({ error: 'No LiveAvatar API key set. Add yours in Profile settings.' });

  try {
    const r = await fetch('https://api.liveavatar.com/v1/avatars/public', {
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
    const results = data.data?.results || data.data || [];
    const avatars = (Array.isArray(results) ? results : []).map(a => ({
      id: a.id,
      name: a.name || a.id,
      preview_url: a.preview_url || a.preview_image_url || '',
    }));
    return res.status(200).json({ avatars });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
}
