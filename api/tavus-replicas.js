export default async function handler(req, res) {
  const apiKey = process.env.TAVUS_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'TAVUS_API_KEY not set on server' });

  try {
    const r = await fetch('https://tavusapi.com/v2/replicas', {
      headers: { 'x-api-key': apiKey },
    });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: data });
    const list = data.data || data.replicas || data || [];
    const replicas = list.map(r => ({ id: r.replica_id || r.id, name: r.replica_name || r.name || r.replica_id || r.id, status: r.status }));
    return res.status(200).json({ replicas });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
}
