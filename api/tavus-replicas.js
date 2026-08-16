// Lists the signed-in user's own Tavus replicas, using their own API key (sent from the
// client, sourced from their Supabase settings) - not a shared Vercel environment variable.
export default async function handler(req, res) {
  const apiKey = req.headers['x-tavus-key'];
  if (!apiKey) return res.status(400).json({ error: 'No Tavus API key set. Add yours in Profile settings.' });

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
