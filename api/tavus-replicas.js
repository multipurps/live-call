import { getServiceClient, getAuthedUserId } from '../lib/supabaseAdmin.js';
import { getProviderKey } from '../lib/keys.js';

// GET (default)      -> the signed-in user's own trained Tavus replicas.
// GET ?type=system   -> Tavus's stock/system preset replica library.
// Combined into one file (was two) to stay under Vercel Hobby's 12-function cap.
export default async function handler(req, res) {
  const supabase = getServiceClient();
  const userId = await getAuthedUserId(req, supabase);
  if (!userId) return res.status(401).json({ error: 'Not signed in' });

  const apiKey = await getProviderKey(supabase, userId, 'tavus');
  if (!apiKey) return res.status(400).json({ error: 'No Tavus API key set. Add yours in Profile settings.' });

  const isSystem = req.query.type === 'system';
  const url = isSystem ? 'https://tavusapi.com/v2/replicas?replica_type=system' : 'https://tavusapi.com/v2/replicas';

  try {
    const r = await fetch(url, { headers: { 'x-api-key': apiKey } });
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
    const results = (Array.isArray(list) ? list : []).map(r => ({
      id: r.replica_id || r.id,
      name: r.replica_name || r.name || r.replica_id || r.id,
      status: r.status,
      preview_url: r.thumbnail_video_url || '',
    }));
    return res.status(200).json(isSystem ? { presets: results } : { replicas: results });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
}
