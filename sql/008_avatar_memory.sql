-- Run once in the Supabase SQL editor for the live-call project. Safe to re-run.
-- Persistent memory for the AI persona (Mitra), so it carries facts across
-- separate calls instead of starting cold every time - one growing text blob
-- per user, prepended into the system prompt on each new call and updated
-- from each call's transcript once it ends. Conceptually mirrors the
-- prefetch (recall before a turn) / sync (persist after) pattern used by
-- proper agent memory systems (e.g. Nous Research's hermes-agent), scaled
-- down to fit this app's actual architecture (Supabase + serverless
-- functions, not a long-running process).
create table if not exists avatar_memory (
  user_id uuid primary key references auth.users(id) on delete cascade,
  facts text not null default '',
  updated_at timestamptz not null default now()
);

alter table avatar_memory enable row level security;

create policy if not exists "own memory only"
  on avatar_memory for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
