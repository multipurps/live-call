-- ============================================================================
-- Run this once in the Supabase SQL editor for the live-call project
-- (ewgtpxomgkpbmfyddypw), then it's done. Safe to re-run (everything is
-- IF NOT EXISTS / OR REPLACE / drop-then-create).
-- ============================================================================

-- 1. The 'branding' bucket already exists in practice (the login background
--    upload has been writing to it), but it isn't tracked in any committed
--    migration - this makes that assumption explicit and recoverable if the
--    project is ever rebuilt from scratch.
insert into storage.buckets (id, name, public)
values ('branding', 'branding', true)
on conflict (id) do nothing;

drop policy if exists "Public can read branding" on storage.objects;
create policy "Public can read branding"
  on storage.objects for select
  to public
  using (bucket_id = 'branding');

-- No public insert/update/delete policy on this bucket - every write goes
-- through an admin API route using the service role key, which bypasses RLS
-- entirely, same as the existing login-bg upload endpoint.

-- 2. Splash backgrounds. Unlike login_bg_url (a single column on app_settings),
--    the splash screen picks one at random on every launch, so this is its own
--    table holding as many images as the admin has uploaded.
create table if not exists splash_backgrounds (
  id uuid primary key default gen_random_uuid(),
  url text not null,
  storage_path text not null,
  created_at timestamptz not null default now()
);

alter table splash_backgrounds enable row level security;

-- Public read (no auth) - the splash has to pick a background before anyone
-- has signed in, on every single app open.
drop policy if exists "Public can read splash backgrounds" on splash_backgrounds;
create policy "Public can read splash backgrounds"
  on splash_backgrounds for select
  to public
  using (true);

-- Deliberately no insert/update/delete policy for anon/authenticated - all
-- writes go through /api/admin-upload-splash-bg using the service role key.
