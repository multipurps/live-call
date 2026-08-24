import { createClient } from '@supabase/supabase-js';
import webpush from 'web-push';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const adminEmail = process.env.ADMIN_EMAIL;
  const vapidPublic = process.env.VAPID_PUBLIC_KEY;
  const vapidPrivate = process.env.VAPID_PRIVATE_KEY;
  const vapidSubject = process.env.VAPID_SUBJECT;
  if (!serviceKey || !adminEmail || !vapidPublic || !vapidPrivate || !vapidSubject) {
    return res.status(500).json({ error: 'Server not configured (missing service key / admin email / VAPID vars)' });
  }

  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Missing auth token' });

  const supabase = createClient('https://ewgtpxomgkpbmfyddypw.supabase.co', serviceKey);
  const { data: userData, error: userErr } = await supabase.auth.getUser(token);
  if (userErr || !userData?.user) return res.status(401).json({ error: 'Invalid session' });
  if ((userData.user.email || '').trim().toLowerCase() !== adminEmail.trim().toLowerCase()) {
    return res.status(403).json({ error: 'Not authorized' });
  }

  const { title, body } = req.body || {};
  if (!title || !body) return res.status(400).json({ error: 'title and body are required' });

  await supabase.from('announcements').insert({ title, body });


  webpush.setVapidDetails(vapidSubject, vapidPublic, vapidPrivate);

  const { data: subs, error: subsErr } = await supabase.from('push_subscriptions').select('*');
  if (subsErr) return res.status(500).json({ error: subsErr.message });

  const payload = JSON.stringify({ title, body });
  let sent = 0, failed = 0;

  await Promise.all((subs || []).map(async (sub) => {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        payload
      );
      sent++;
    } catch (err) {
      failed++;
      if (err.statusCode === 410 || err.statusCode === 404) {
        await supabase.from('push_subscriptions').delete().eq('id', sub.id); // stale subscription, clean it up
      }
    }
  }));

  return res.status(200).json({ sent, failed, total: (subs || []).length });
}
