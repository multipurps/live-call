-- Run once in the Supabase SQL editor. Tracks whether we've already pushed the
-- fixed humanizer reference doc into a user's Anam Knowledge base, so we only
-- do it once per user rather than re-uploading on every key save/update.
alter table video_call_settings
  add column if not exists anam_knowledge_doc_pushed boolean default false;
