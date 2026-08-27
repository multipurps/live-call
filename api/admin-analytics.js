import { createClient } from '@supabase/supabase-js';

// Usage leaderboard for the admin panel. No new tracking table needed - we
// already have per-user activity in video_call_history (one row per call)
// and video_call_chats (one row per chat, updated on every message), so this
// just aggregates those against user_approvals for email + join date.
// Same admin check as the other admin endpoints; reads go through the
// service role key, which bypasses RLS.
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

  const [usersRes, callsRes, chatsRes] = await Promise.all([
    supabase.from('user_approvals').select('user_id, email, created_at'),
    supabase.from('video_call_history').select('user_id, created_at'),
    supabase.from('video_call_chats').select('user_id, updated_at'),
  ]);
  if (usersRes.error) return res.status(500).json({ error: usersRes.error.message });
  if (callsRes.error) return res.status(500).json({ error: callsRes.error.message });
  if (chatsRes.error) return res.status(500).json({ error: chatsRes.error.message });

  const stats = {};
  const bump = (userId, field, ts) => {
    if (!userId) return;
    if (!stats[userId]) stats[userId] = { calls: 0, chats: 0, lastActive: null };
    stats[userId][field]++;
    if (ts && (!stats[userId].lastActive || ts > stats[userId].lastActive)) stats[userId].lastActive = ts;
  };
  (callsRes.data || []).forEach(c => bump(c.user_id, 'calls', c.created_at));
  (chatsRes.data || []).forEach(c => bump(c.user_id, 'chats', c.updated_at));

  const rows = (usersRes.data || []).map(u => {
    const s = stats[u.user_id] || { calls: 0, chats: 0, lastActive: null };
    return {
      user_id: u.user_id,
      email: u.email,
      calls: s.calls,
      chats: s.chats,
      total: s.calls + s.chats,
      lastActive: s.lastActive,
      joined: u.created_at,
    };
  }).sort((a, b) => b.total - a.total);

  return res.status(200).json({ users: rows });
}
