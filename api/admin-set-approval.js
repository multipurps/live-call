import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const adminEmail = process.env.ADMIN_EMAIL;
  if (!serviceKey || !adminEmail) return res.status(500).json({ error: 'Server not configured' });

  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Missing auth token' });

  const supabase = createClient('https://ewgtpxomgkpbmfyddypw.supabase.co', serviceKey);

  const { data: userData, error: userErr } = await supabase.auth.getUser(token);
  if (userErr || !userData?.user) return res.status(401).json({ error: 'Invalid session' });
  if (userData.user.email !== adminEmail) return res.status(403).json({ error: 'Not authorized' });

  const { targetUserId, approved } = req.body || {};
  if (!targetUserId || typeof approved !== 'boolean') return res.status(400).json({ error: 'targetUserId and approved (boolean) required' });

  const { error } = await supabase.from('user_approvals').update({ approved }).eq('user_id', targetUserId);
  if (error) return res.status(500).json({ error: error.message });
  return res.status(200).json({ ok: true });
}
