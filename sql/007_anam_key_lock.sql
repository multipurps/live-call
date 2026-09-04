-- Run once in the Supabase SQL editor for the live-call project. Safe to re-run.
-- Lets the admin lock a specific user's ability to change a saved provider
-- key, so a user who exhausted a provider's free-tier credits can't just
-- paste in a fresh key from a new free account to farm more credits.
alter table video_call_settings
  add column if not exists anam_key_locked boolean not null default false;
