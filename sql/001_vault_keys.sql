-- ============================================================================
-- Run this once in the Supabase SQL editor for the live-call project
-- (ewgtpxomgkpbmfyddypw), then it's done. Safe to re-run (everything is
-- IF NOT EXISTS / OR REPLACE).
-- ============================================================================

-- 1. Secret-ID columns replace the old plaintext *_api_key columns. The old
--    plaintext columns are left in place untouched (harmless, just unused
--    going forward) rather than dropped, in case a rollback is ever needed.
alter table video_call_settings
  add column if not exists heygen_api_key_secret_id uuid,
  add column if not exists tavus_api_key_secret_id  uuid,
  add column if not exists anam_api_key_secret_id   uuid;

-- 2. Anam custom avatar/voice columns. avatar_id/avatar_name may already exist
--    from an earlier migration - IF NOT EXISTS makes this safe either way.
alter table video_call_settings
  add column if not exists anam_avatar_id   text,
  add column if not exists anam_avatar_name text,
  add column if not exists anam_voice_id    text,
  add column if not exists anam_voice_name  text;

-- 3. Vault is not exposed over the REST API directly (Supabase only exposes
--    the `public` schema by default), so these SECURITY DEFINER wrapper
--    functions live in `public` and do the vault.* calls internally. They're
--    revoked from anon/authenticated and granted only to service_role, so
--    only our backend (using SUPABASE_SERVICE_ROLE_KEY) can ever call them -
--    never directly reachable by a signed-in user's own session.
create or replace function public.vault_create_secret(secret text, name text default null)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
begin
  return vault.create_secret(secret, name);
end;
$$;

create or replace function public.vault_update_secret(p_id uuid, p_secret text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform vault.update_secret(p_id, p_secret);
end;
$$;

create or replace function public.vault_decrypt_secret(p_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  result text;
begin
  select decrypted_secret into result from vault.decrypted_secrets where id = p_id;
  return result;
end;
$$;

create or replace function public.vault_delete_secret(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from vault.secrets where id = p_id;
end;
$$;

revoke all on function public.vault_create_secret(text, text) from public, anon, authenticated;
revoke all on function public.vault_update_secret(uuid, text) from public, anon, authenticated;
revoke all on function public.vault_decrypt_secret(uuid) from public, anon, authenticated;
revoke all on function public.vault_delete_secret(uuid) from public, anon, authenticated;

grant execute on function public.vault_create_secret(text, text) to service_role;
grant execute on function public.vault_update_secret(uuid, text) to service_role;
grant execute on function public.vault_decrypt_secret(uuid) to service_role;
grant execute on function public.vault_delete_secret(uuid) to service_role;

-- 4. Storage bucket for custom avatar photos (voice clips go straight to Anam via a
--    presigned URL, never touching our storage - only avatar photos need to be hosted
--    at a public URL for Anam's create-avatar endpoint to fetch from).
insert into storage.buckets (id, name, public)
values ('user-uploads', 'user-uploads', true)
on conflict (id) do nothing;

-- CREATE POLICY has no IF NOT EXISTS in Postgres - drop-then-create makes this safe to re-run.
drop policy if exists "Users can upload their own files" on storage.objects;
create policy "Users can upload their own files"
  on storage.objects for insert
  to authenticated
  with check (bucket_id = 'user-uploads' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "Users can update their own files" on storage.objects;
create policy "Users can update their own files"
  on storage.objects for update
  to authenticated
  using (bucket_id = 'user-uploads' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "Users can delete their own files" on storage.objects;
create policy "Users can delete their own files"
  on storage.objects for delete
  to authenticated
  using (bucket_id = 'user-uploads' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "Public can read uploaded files" on storage.objects;
create policy "Public can read uploaded files"
  on storage.objects for select
  to public
  using (bucket_id = 'user-uploads');

