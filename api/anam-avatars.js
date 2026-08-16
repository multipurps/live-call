// Lists the caller's available Anam avatars (stock + any custom ones on their account).
export default async function handler(req, res) {
  const apiKey = req.headers['x-anam-key'];
  if (!apiKey) return res.status(400).json({ error: 'No Anam API key set. Add yours in Profile settings.' });

  try {
    const r = await fetch('https://api.anam.ai/v1/avatars', {
      headers: { Authorization: `Bearer ${apiKey}` },
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
    const list = data.data || data.avatars || data || [];
    const avatars = (Array.isArray(list) ? list : []).map(a => ({
      id: a.id,
      name: a.displayName || a.name || a.id,
      preview_url: a.videoUrl || a.previewUrl || '',
    }));
    return res.status(200).json({ avatars });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
}
