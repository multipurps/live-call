import { getServiceClient, getAuthedUserId } from '../lib/supabaseAdmin.js';
import { getProviderKey, saveProviderKey } from '../lib/keys.js';
import { HUMANIZER_DOC, HUMANIZER_DOC_FILENAME } from '../lib/humanizerDoc.js';

const PROVIDERS = ['tavus', 'anam', 'fal'];

// Pushes the fixed persona reference doc into this user's own Anam Knowledge
// base, using their own key. Runs once per user (tracked via
// anam_knowledge_doc_pushed) right after their key is first saved, so it
// happens invisibly during onboarding - no Anam dashboard visit required.
// Anam's presigned-upload flow is the same 3-step pattern used for voice
// cloning: request a URL, PUT the bytes, confirm.
async function pushHumanizerDoc(supabase, userId, apiKey) {
  try {
    const { data: existing } = await supabase
      .from('video_call_settings')
      .select('anam_knowledge_doc_pushed')
      .eq('user_id', userId)
      .maybeSingle();
    if (existing?.anam_knowledge_doc_pushed) return; // already done for this user

    const authHeaders = { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' };
    const bytes = new TextEncoder().encode(HUMANIZER_DOC);

    // Knowledge documents live inside a group (folder) - create one to hold this doc.
    const groupResp = await fetch('https://api.anam.ai/v1/knowledge/groups', {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ name: 'Call Persona Guide' }),
    });
    if (!groupResp.ok) return;
    const { id: folderId } = await groupResp.json();
    if (!folderId) return;

    const presignResp = await fetch(`https://api.anam.ai/v1/knowledge/groups/${folderId}/documents/presigned-upload`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        filename: HUMANIZER_DOC_FILENAME,
        contentType: 'text/plain',
        fileSize: bytes.byteLength,
      }),
    });
    if (!presignResp.ok) return; // non-fatal - key save should still succeed either way
    const { uploadUrl, documentId } = await presignResp.json();
    if (!uploadUrl || !documentId) return;

    const putResp = await fetch(uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'text/plain' },
      body: bytes,
    });
    if (!putResp.ok) return;

    const confirmResp = await fetch(`https://api.anam.ai/v1/knowledge/documents/${documentId}/confirm-upload`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ fileSize: bytes.byteLength }),
    });
    if (!confirmResp.ok) return;

    await supabase
      .from('video_call_settings')
      .upsert({ user_id: userId, anam_knowledge_doc_pushed: true, updated_at: new Date().toISOString() });
  } catch (err) {
    // Silent by design - this is a background enhancement, never block the
    // user's actual key save on it. Worth logging server-side if this becomes
    // a support question later.
    console.error('pushHumanizerDoc failed:', err);
  }
}

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
    const { data: settings } = await supabase
      .from('video_call_settings')
      .select('anam_key_locked')
      .eq('user_id', userId)
      .maybeSingle();
    status.anamKeyLocked = !!settings?.anam_key_locked;
    return res.status(200).json(status);
  }

  if (req.method === 'POST') {
    const { provider, key } = req.body || {};
    if (!PROVIDERS.includes(provider)) return res.status(400).json({ error: 'Unknown provider' });
    if (!key || !key.trim()) return res.status(400).json({ error: 'Empty key' });
    if (provider === 'anam') {
      const { data: settings } = await supabase
        .from('video_call_settings')
        .select('anam_key_locked')
        .eq('user_id', userId)
        .maybeSingle();
      if (settings?.anam_key_locked) {
        return res.status(403).json({ error: 'Your Anam key is locked and can\u2019t be changed. Contact support if you need this updated.' });
      }
    }
    const { error } = await saveProviderKey(supabase, userId, provider, key.trim());
    if (error) return res.status(500).json({ error: error.message || String(error) });
    if (provider === 'anam') await pushHumanizerDoc(supabase, userId, key.trim());
    return res.status(200).json({ saved: true });
  }

  return res.status(405).json({ error: 'GET or POST only' });
}
