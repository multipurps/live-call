-- Run once in the Supabase SQL editor for the live-call project. Safe to re-run.
-- Adds the vault secret-id column for the Decart API key (Live Swap feature,
-- now going direct to Decart instead of proxying through Fal - see
-- 006_fal_key.sql, which this supersedes for Live Swap. The old
-- fal_api_key_secret_id column is left in place untouched (harmless, just
-- unused going forward) rather than dropped, in case a rollback is ever
-- needed - same reasoning as 001_vault_keys.sql's note on the plaintext
-- columns it replaced.
alter table video_call_settings
  add column if not exists decart_api_key_secret_id uuid;
