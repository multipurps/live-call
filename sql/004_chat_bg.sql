-- Run once in the Supabase SQL editor for the live-call project
-- (ewgtpxomgkpbmfyddypw). Safe to re-run (IF NOT EXISTS).

-- Chat interface background - same single-column pattern as login_bg_url on
-- app_settings. Applied to the Home/chat screen once a user is signed in
-- (login_bg_url only ever shows on the signed-out login screen).
alter table app_settings
  add column if not exists chat_bg_url text;
