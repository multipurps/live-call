import { createClient } from '@supabase/supabase-js';

// Uploads (or clears) the login screen's background image. Only the configured admin
// (ADMIN_EMAIL) can call this - same check as the other admin endpoints. Writes go
// through the service role key, which bypasses the 'branding' bucket's RLS, so no
// public write policy is ever needed on that bucket.
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
  const signedInEmail = (userData.user.email || '').trim().toLowerCase();
  if (signedInEmail !== adminEmail.trim().toLowerCase()) {
    return res.status(403).json({ error: `Not authorized — signed in as "${userData.user.email}", expected admin email to match server's ADMIN_EMAIL` });
  }

  const { action } = req.body || {};

  if (action === 'clear') {
    const { error } = await supabase.from('app_settings').update({ login_bg_url: null }).eq('id', true);
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ ok: true, url: null });
  }

  const { imageBase64, fileExt } = req.body || {};
  if (!imageBase64 || !fileExt) return res.status(400).json({ error: 'imageBase64 and fileExt are required' });
  if (!['png', 'jpg', 'jpeg', 'webp'].includes(fileExt.toLowerCase())) {
    return res.status(400).json({ error: 'fileExt must be png, jpg, jpeg, or webp' });
  }

  try {
    const base64Data = imageBase64.includes(',') ? imageBase64.split(',')[1] : imageBase64;
    const buffer = Buffer.from(base64Data, 'base64');
    if (buffer.length > 8 * 1024 * 1024) return res.status(400).json({ error: 'Image too large (max 8MB)' });

    const path = `login-bg.${fileExt.toLowerCase()}`;
    const { error: uploadErr } = await supabase.storage.from('branding').upload(path, buffer, {
      contentType: `image/${fileExt.toLowerCase() === 'jpg' ? 'jpeg' : fileExt.toLowerCase()}`,
      upsert: true,
    });
    if (uploadErr) return res.status(500).json({ error: uploadErr.message });

    const { data: publicUrlData } = supabase.storage.from('branding').getPublicUrl(path);
    // Cache-bust so the new image shows immediately instead of the old cached one at the same path
    const url = `${publicUrlData.publicUrl}?v=${Date.now()}`;

    const { error: settingsErr } = await supabase.from('app_settings').upsert({ id: true, login_bg_url: url, updated_at: new Date().toISOString() });
    if (settingsErr) return res.status(500).json({ error: settingsErr.message });

    return res.status(200).json({ ok: true, url });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
}
