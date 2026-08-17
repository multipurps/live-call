// Every provider's key is stored as a Vault secret id in video_call_settings
// (`${provider}_api_key_secret_id`), never in plaintext. These wrap the
// vault_* SECURITY DEFINER SQL functions (see sql/001_vault_keys.sql) that
// only service_role can call.

const COLUMN = (provider) => `${provider}_api_key_secret_id`;

// Returns the user's decrypted key for this provider, or null if they haven't
// saved one yet.
export async function getProviderKey(supabase, userId, provider) {
  const { data, error } = await supabase
    .from('video_call_settings')
    .select(COLUMN(provider))
    .eq('user_id', userId)
    .maybeSingle();
  if (error || !data) return null;
  const secretId = data[COLUMN(provider)];
  if (!secretId) return null;
  const { data: decrypted, error: decErr } = await supabase.rpc('vault_decrypt_secret', { p_id: secretId });
  if (decErr) return null;
  return decrypted || null;
}

// Encrypts and stores a new key for this provider, creating the settings row
// if it doesn't exist yet, updating the existing vault secret in place if one
// was already saved (so old secret rows don't pile up on every re-save).
export async function saveProviderKey(supabase, userId, provider, plaintext) {
  const { data: existing } = await supabase
    .from('video_call_settings')
    .select(COLUMN(provider))
    .eq('user_id', userId)
    .maybeSingle();

  const existingSecretId = existing?.[COLUMN(provider)];
  let secretId = existingSecretId;

  if (existingSecretId) {
    const { error } = await supabase.rpc('vault_update_secret', { p_id: existingSecretId, p_secret: plaintext });
    if (error) return { error };
  } else {
    const { data: newId, error } = await supabase.rpc('vault_create_secret', {
      secret: plaintext,
      name: `${provider}_key_${userId}`,
    });
    if (error) return { error };
    secretId = newId;
  }

  const { error: upsertErr } = await supabase
    .from('video_call_settings')
    .upsert({ user_id: userId, [COLUMN(provider)]: secretId, updated_at: new Date().toISOString() });
  return { error: upsertErr };
}
