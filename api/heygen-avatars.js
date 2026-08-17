import { getServiceClient, getAuthedUserId } from '../lib/supabaseAdmin.js';
import { getProviderKey } from '../lib/keys.js';

// GET ?type=private (default) -> the signed-in user's own LiveAvatar avatars.
// GET ?type=public            -> LiveAvatar's public avatar directory.
// Combined into one file (was two) to stay under Vercel Hobby's 12-function cap.
// The LiveAvatar key is looked up server-side from the user's own encrypted
// settings (Vault) rather than trusted from a client-sent header.
export default async function handler(req, res) {
  const supabase = getServiceClient();
  const userId = await getAuthedUserId(req, supabase);
  if (!userId) return res.status(401).json({ error: 'Not signed in' });

  const apiKey = await getProviderKey(supabase, userId, 'heygen');
  if (!apiKey) return res.status(400).json({ error: 'No LiveAvatar API key set. Add yours in Profile settings.' });

  const isPublic = req.query.type === 'public';
  const url = isPublic
    ? 'https://api.liveavatar.com/v1/avatars/public'
    : 'https://api.liveavatar.com/v1/avatars?page=1&page_size=100';

  try {
    const r = await fetch(url, { headers: { 'X-API-KEY': apiKey } });
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
