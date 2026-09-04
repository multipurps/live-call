import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const adminEmail = process.env.ADMIN_EMAIL;
  if (!serviceKey || !adminEmail) return res.status(500).json({ error: 'Server not configured (SUPABASE_SERVICE_ROLE_KEY / ADMIN_EMAIL missing)' });

  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Missing auth token' });

  const supabase = createClient('https://ewgtpxomgkpbmfyddypw.supabase.co', serviceKey);

  const { data: userData, error: userErr } = await supabase.auth.getUser(token);
  if (userErr || !userData?.user) return res.status(401).json({ error: 'Invalid session' });
  const signedInEmail = (userData.user.email || '').trim().toLowerCase();
  if (signedInEmail !== adminEmail.trim().toLowerCase()) {
    return res.status(403).json({ error: `Not authorized — signed in as "${userData.user.email}", expected admin email to match server's ADMIN_EMAIL` });
  }

  const { data, error } = await supabase
    .from('user_approvals')
    .select('user_id, email, approved, created_at')
    .order('created_at', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });

  const { data: settingsRows } = await supabase
    .from('video_call_settings')
    .select('user_id, anam_key_locked');
  const lockedByUser = Object.fromEntries((settingsRows || []).map(r => [r.user_id, !!r.anam_key_locked]));
  const users = data.map(u => ({ ...u, anam_key_locked: !!lockedByUser[u.user_id] }));

  return res.status(200).json({ users });
}
