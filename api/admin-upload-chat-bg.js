import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'crypto';

// Adds or removes one of the chat interface's background images. Unlike the
// login background (a single app_settings column), chat backgrounds can hold many -
// each user picks their own from it in-app - this is add/delete against
// the chat_backgrounds table rather than upsert/clear against one row.
// Same admin check as the other admin endpoints; writes go through the
// service role key, which bypasses RLS, so no public write policy is ever
// needed on the table or the 'branding' bucket.
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

  if (action === 'delete') {
    const { id } = req.body || {};
    if (!id) return res.status(400).json({ error: 'id is required' });

    const { data: row, error: fetchErr } = await supabase
      .from('chat_backgrounds')
      .select('storage_path')
      .eq('id', id)
      .maybeSingle();
    if (fetchErr) return res.status(500).json({ error: fetchErr.message });
    if (!row) return res.status(404).json({ error: 'Not found' });

    const { error: removeErr } = await supabase.storage.from('branding').remove([row.storage_path]);
    if (removeErr) return res.status(500).json({ error: removeErr.message });

    const { error: deleteErr } = await supabase.from('chat_backgrounds').delete().eq('id', id);
    if (deleteErr) return res.status(500).json({ error: deleteErr.message });

    return res.status(200).json({ ok: true });
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

    const ext = fileExt.toLowerCase();
    const path = `chat/${randomUUID()}.${ext}`;
    const { error: uploadErr } = await supabase.storage.from('branding').upload(path, buffer, {
      contentType: `image/${ext === 'jpg' ? 'jpeg' : ext}`,
      upsert: false,
    });
    if (uploadErr) return res.status(500).json({ error: uploadErr.message });

    const { data: publicUrlData } = supabase.storage.from('branding').getPublicUrl(path);
    const url = publicUrlData.publicUrl;

    const { data: row, error: insertErr } = await supabase
      .from('chat_backgrounds')
      .insert({ url, storage_path: path })
      .select()
      .single();
    if (insertErr) return res.status(500).json({ error: insertErr.message });

    return res.status(200).json({ ok: true, row });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
}
