-- Run once in the Supabase SQL editor for the live-call project. Safe to re-run.
-- Adds the vault secret-id column for the Fal API key (Live Filter feature),
-- following the same pattern as the anam/tavus columns in 001_vault_keys.sql.
alter table video_call_settings
  add column if not exists fal_api_key_secret_id uuid;
