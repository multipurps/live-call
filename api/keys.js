import { getServiceClient, getAuthedUserId } from '../lib/supabaseAdmin.js';
import { getProviderKey, saveProviderKey } from '../lib/keys.js';

const PROVIDERS = ['heygen', 'tavus', 'anam'];

export default async function handler(req, res) {
  const supabase = getServiceClient();
  const userId = await getAuthedUserId(req, supabase);
  if (!userId) return res.status(401).json({ error: 'Not signed in' });

  if (req.method === 'GET') {
    // Only ever reports whether a key is set, never the key itself - the
    // plaintext key never leaves the vault after the moment it's first saved.
    const status = {};
    for (const p of PROVIDERS) {
      const key = await getProviderKey(supabase, userId, p);
      status[p] = !!key;
    }
    return res.status(200).json(status);
  }

  if (req.method === 'POST') {
    const { provider, key } = req.body || {};
    if (!PROVIDERS.includes(provider)) return res.status(400).json({ error: 'Unknown provider' });
    if (!key || !key.trim()) return res.status(400).json({ error: 'Empty key' });
    const { error } = await saveProviderKey(supabase, userId, provider, key.trim());
    if (error) return res.status(500).json({ error: error.message || String(error) });
    return res.status(200).json({ saved: true });
  }

  return res.status(405).json({ error: 'GET or POST only' });
}
