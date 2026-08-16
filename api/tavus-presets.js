// Lists Tavus's stock/system replicas (replica_type=system) - a public preset library
// anyone can use, not just the caller's own trained replicas from /v2/replicas. Same
// auth pattern as tavus-replicas.js: the caller's own Tavus key is forwarded, sent by
// the client on each request.
export default async function handler(req, res) {
  const apiKey = req.headers['x-tavus-key'];
  if (!apiKey) return res.status(400).json({ error: 'No Tavus API key set. Add yours in Profile settings.' });

  try {
    const r = await fetch('https://tavusapi.com/v2/replicas?replica_type=system', {
      headers: { 'x-api-key': apiKey },
    });
    const raw = await r.text();
    let data;
    try { data = JSON.parse(raw); }
    catch {
      return res.status(502).json({
        error: `Tavus returned a non-JSON response (status ${r.status}). This usually means your Tavus API key is invalid. Raw response: ${raw.slice(0, 200)}`
      });
    }
    if (!r.ok) return res.status(r.status).json({ error: data });
    const list = data.data || data.replicas || data || [];
    const presets = (Array.isArray(list) ? list : []).map(r => ({
      id: r.replica_id || r.id,
      name: r.replica_name || r.name || r.replica_id || r.id,
      preview_url: r.thumbnail_video_url || '',
    }));
    return res.status(200).json({ presets });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
}
