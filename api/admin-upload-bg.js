import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'crypto';

// Handles all three admin background surfaces (login, splash, chat) in one function -
// merged from three separate files to stay under Vercel's serverless function cap.
// Same admin check throughout; writes go through the service role key, which bypasses
// RLS, so no public write policy is ever needed on the 'branding' bucket or these tables.
async function requireAdmin(req, supabase, adminEmail) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return { error: 'Missing auth token', status: 401 };
  const { data: userData, error: userErr } = await supabase.auth.getUser(token);
  if (userErr || !userData?.user) return { error: 'Invalid session', status: 401 };
  const signedInEmail = (userData.user.email || '').trim().toLowerCase();
  if (signedInEmail !== adminEmail.trim().toLowerCase()) {
    return { error: `Not authorized — signed in as "${userData.user.email}"`, status: 403 };
  }
  return { ok: true };
}

function decodeImage(imageBase64) {
  const base64Data = imageBase64.includes(',') ? imageBase64.split(',')[1] : imageBase64;
  return Buffer.from(base64Data, 'base64');
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const adminEmail = process.env.ADMIN_EMAIL;
  if (!serviceKey || !adminEmail) return res.status(500).json({ error: 'Server not configured' });

  const supabase = createClient('https://ewgtpxomgkpbmfyddypw.supabase.co', serviceKey);
  const auth = await requireAdmin(req, supabase, adminEmail);
  if (auth.error) return res.status(auth.status).json({ error: auth.error });

  const { target, action } = req.body || {}; // target: 'login' | 'splash' | 'chat'

  try {
    if (target === 'login') {
      if (action === 'clear') {
        const { error } = await supabase.from('app_settings').update({ login_bg_url: null }).eq('id', true);
        if (error) return res.status(500).json({ error: error.message });
        return res.status(200).json({ ok: true, url: null });
      }
      const { imageBase64, fileExt } = req.body || {};
      if (!imageBase64 || !fileExt) return res.status(400).json({ error: 'imageBase64 and fileExt are required' });
      const ext = fileExt.toLowerCase();
      if (!['png', 'jpg', 'jpeg', 'webp'].includes(ext)) return res.status(400).json({ error: 'fileExt must be png, jpg, jpeg, or webp' });

      const buffer = decodeImage(imageBase64);
      if (buffer.length > 8 * 1024 * 1024) return res.status(400).json({ error: 'Image too large (max 8MB)' });

      const path = `login-bg.${ext}`;
      const { error: uploadErr } = await supabase.storage.from('branding').upload(path, buffer, { contentType: `image/${ext === 'jpg' ? 'jpeg' : ext}`, upsert: true });
      if (uploadErr) return res.status(500).json({ error: uploadErr.message });

      const { data: pub } = supabase.storage.from('branding').getPublicUrl(path);
      const url = `${pub.publicUrl}?v=${Date.now()}`;
      const { error: settingsErr } = await supabase.from('app_settings').upsert({ id: true, login_bg_url: url, updated_at: new Date().toISOString() });
      if (settingsErr) return res.status(500).json({ error: settingsErr.message });
      return res.status(200).json({ ok: true, url });
    }

    if (target === 'splash' || target === 'chat') {
      const table = target === 'splash' ? 'splash_backgrounds' : 'chat_backgrounds';

      if (action === 'setDefault' && target === 'chat') {
        const { url } = req.body || {};
        if (!url) return res.status(400).json({ error: 'url is required' });
        const { error } = await supabase.from('app_settings').upsert({ id: true, chat_bg_url: url, updated_at: new Date().toISOString() });
        if (error) return res.status(500).json({ error: error.message });
        return res.status(200).json({ ok: true });
      }
      if (action === 'clearDefault' && target === 'chat') {
        const { error } = await supabase.from('app_settings').update({ chat_bg_url: null }).eq('id', true);
        if (error) return res.status(500).json({ error: error.message });
        return res.status(200).json({ ok: true });
      }
      if (action === 'delete') {
        const { id } = req.body || {};
        if (!id) return res.status(400).json({ error: 'id is required' });
        const { data: row, error: fetchErr } = await supabase.from(table).select('storage_path').eq('id', id).maybeSingle();
        if (fetchErr) return res.status(500).json({ error: fetchErr.message });
        if (!row) return res.status(404).json({ error: 'Not found' });
        const { error: removeErr } = await supabase.storage.from('branding').remove([row.storage_path]);
        if (removeErr) return res.status(500).json({ error: removeErr.message });
        const { error: deleteErr } = await supabase.from(table).delete().eq('id', id);
        if (deleteErr) return res.status(500).json({ error: deleteErr.message });
        return res.status(200).json({ ok: true });
      }

      const { imageBase64, fileExt } = req.body || {};
      if (!imageBase64 || !fileExt) return res.status(400).json({ error: 'imageBase64 and fileExt are required' });
      const ext = fileExt.toLowerCase();
      if (!['png', 'jpg', 'jpeg', 'webp'].includes(ext)) return res.status(400).json({ error: 'fileExt must be png, jpg, jpeg, or webp' });

      const buffer = decodeImage(imageBase64);
      if (buffer.length > 8 * 1024 * 1024) return res.status(400).json({ error: 'Image too large (max 8MB)' });

      const path = `${target}/${randomUUID()}.${ext}`;
      const { error: uploadErr } = await supabase.storage.from('branding').upload(path, buffer, { contentType: `image/${ext === 'jpg' ? 'jpeg' : ext}`, upsert: false });
      if (uploadErr) return res.status(500).json({ error: uploadErr.message });

      const { data: pub } = supabase.storage.from('branding').getPublicUrl(path);
      const { data: row, error: insertErr } = await supabase.from(table).insert({ url: pub.publicUrl, storage_path: path }).select().single();
      if (insertErr) return res.status(500).json({ error: insertErr.message });
      return res.status(200).json({ ok: true, row });
    }

    return res.status(400).json({ error: 'target must be "login", "splash", or "chat"' });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
}
