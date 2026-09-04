-- Run once in the Supabase SQL editor for the live-call project. Safe to re-run.
--
-- One-time cleanup + a self-healing fix for a real failure mode hit in
-- production: saveProviderKey() (lib/keys.js) creates a vault secret named
-- `${provider}_key_${userId}` BEFORE writing its id into video_call_settings.
-- If that second write fails for any reason (e.g. the settings column didn't
-- exist yet because this migration ran a moment after a key-save attempt),
-- the vault secret is orphaned - not referenced by any settings row - and
-- every future save for that user+provider then fails with "duplicate key
-- value violates unique constraint secrets_name_idx", because vault secret
-- names must be unique and the create step keeps trying to reuse the same
-- name with no way to find and update the orphan instead.

-- 1. Lets the app look up an existing vault secret by its deterministic name
--    so it can update (and adopt) an orphan instead of failing to create a
--    duplicate. SECURITY DEFINER + revoked from anon/authenticated, same
--    lockdown as every other vault_* wrapper in 001_vault_keys.sql - only
--    service_role (our backend) can ever call this.
create or replace function public.vault_find_secret_by_name(p_name text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  result uuid;
begin
  select id into result from vault.secrets where name = p_name limit 1;
  return result;
end;
$$;

revoke all on function public.vault_find_secret_by_name(text) from public, anon, authenticated;

-- 2. One-time cleanup for the specific orphan already hit: deletes any vault
--    secret named `decart_key_<uuid>` that has no matching
--    video_call_settings.decart_api_key_secret_id row pointing at it, so the
--    next Save attempt creates a fresh one cleanly. Safe to re-run - it's a
--    no-op once there's nothing orphaned left to clean up.
delete from vault.secrets s
where s.name like 'decart_key_%'
  and not exists (
    select 1 from video_call_settings vcs
    where vcs.decart_api_key_secret_id = s.id
  );
