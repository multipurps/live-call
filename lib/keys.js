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
    const secretName = `${provider}_key_${userId}`;
    const { data: newId, error } = await supabase.rpc('vault_create_secret', {
      secret: plaintext,
      name: secretName,
    });
    if (error) {
      // A secret with this exact name can already exist without any
      // settings row pointing at it - e.g. a prior save's vault_create_secret
      // succeeded but the settings upsert below it failed for any reason
      // (a column added moments too late by a migration, a dropped
      // connection, etc), orphaning it. That leaves every future save
      // permanently failing with a unique-constraint error and no way
      // forward, since the create step keeps colliding on the same
      // deterministic name. Self-heal: look the orphan up by name and adopt
      // it (update its value in place) instead of surfacing that as a save
      // failure forever.
      if (String(error.message || '').includes('duplicate key value') || String(error.message || '').includes('unique constraint')) {
        const { data: foundId, error: findErr } = await supabase.rpc('vault_find_secret_by_name', { p_name: secretName });
        if (!findErr && foundId) {
          const { error: updateErr } = await supabase.rpc('vault_update_secret', { p_id: foundId, p_secret: plaintext });
          if (updateErr) return { error: updateErr };
          secretId = foundId;
        } else {
          return { error };
        }
      } else {
        return { error };
      }
    } else {
      secretId = newId;
    }
  }

  const { error: upsertErr } = await supabase
    .from('video_call_settings')
    .upsert({ user_id: userId, [COLUMN(provider)]: secretId, updated_at: new Date().toISOString() });
  return { error: upsertErr };
}
