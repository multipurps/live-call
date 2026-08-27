-- Run once in the Supabase SQL editor for the live-call project
-- (ewgtpxomgkpbmfyddypw). Safe to re-run.

-- Supersedes 004_chat_bg.sql's app_settings.chat_bg_url (single global image).
-- Chat background is now a gallery the admin can keep adding to, and each
-- user picks their own from it - same shape as splash_backgrounds, plus one
-- column on video_call_settings to remember each user's pick.

create table if not exists chat_backgrounds (
  id uuid primary key default gen_random_uuid(),
  url text not null,
  storage_path text not null,
  created_at timestamptz not null default now()
);

alter table chat_backgrounds enable row level security;

drop policy if exists "Public can read chat backgrounds" on chat_backgrounds;
create policy "Public can read chat backgrounds"
  on chat_backgrounds for select
  to public
  using (true);

-- Deliberately no insert/update/delete policy for anon/authenticated - all
-- writes go through /api/admin-upload-chat-bg using the service role key.

alter table video_call_settings
  add column if not exists chat_bg_url text;

-- The old single-image column is unused now but left in place (harmless) in
-- case you still want a fallback default for users who haven't picked one:
--   alter table app_settings drop column if exists chat_bg_url;
