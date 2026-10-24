-- Conect: persist each member's relationship preference.
-- Run this once in the Supabase SQL Editor before deploying the matching Edge Function.

alter table public.profiles
  add column if not exists looking_for text not null default 'any';

comment on column public.profiles.looking_for is
  'Member preference: younger, older, care_for_me, care_for, or any.';

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'profiles_looking_for_valid_value'
      and conrelid = 'public.profiles'::regclass
  ) then
    alter table public.profiles
      add constraint profiles_looking_for_valid_value
      check (looking_for in ('younger', 'older', 'care_for_me', 'care_for', 'any'));
  end if;
end $$;
