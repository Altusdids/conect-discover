-- Conect: profile visits, private contact email, and blocked-user management
-- Run once in Supabase SQL Editor before deploying the matching Edge Function update.

alter table public.profiles
  add column if not exists email text;

comment on column public.profiles.email is
  'Optional private contact email. Do not expose it in discovery cards or other users'' profile responses.';

create table if not exists public.profile_visits (
  visitor_user_id uuid not null references public.profiles(id) on delete cascade,
  visited_user_id uuid not null references public.profiles(id) on delete cascade,
  last_visited_at timestamptz not null default now(),
  primary key (visitor_user_id, visited_user_id),
  check (visitor_user_id <> visited_user_id)
);

create index if not exists profile_visits_visited_recent_idx
  on public.profile_visits (visited_user_id, last_visited_at desc);

create index if not exists profile_visits_visitor_idx
  on public.profile_visits (visitor_user_id, last_visited_at desc);

alter table public.profile_visits enable row level security;

-- Profile visits and private email are only managed by the server-side Edge Function.
revoke all on table public.profile_visits from anon, authenticated;
