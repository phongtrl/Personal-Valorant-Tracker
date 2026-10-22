-- Run this once in Supabase: SQL Editor > New query > paste > Run.

create table if not exists public.favorite_accounts (
  user_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  riot_key   text not null,            -- lowercase "name#tag"
  name       text not null,
  tag        text not null,
  region     text,
  created_at timestamptz not null default now(),
  primary key (user_id, riot_key)
);

create table if not exists public.matches (
  user_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  riot_key   text not null,            -- which tracked account the match belongs to
  match_id   text not null,
  started_at timestamptz,
  data       jsonb not null,           -- the match object the app builds
  primary key (user_id, riot_key, match_id)
);

alter table public.favorite_accounts enable row level security;
alter table public.matches enable row level security;

create policy "own favorites" on public.favorite_accounts
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

create policy "own matches" on public.matches
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- Added for synced settings (last opened account, mode filter).
-- If you already ran the file above, run only this block.
create table if not exists public.user_settings (
  user_id    uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  settings   jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.user_settings enable row level security;

create policy "own settings" on public.user_settings
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));
