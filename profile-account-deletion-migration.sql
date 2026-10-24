-- Conect: transactional cleanup for permanently deleting a user's account.
-- The Edge Function must first remove the user's storage objects from the profile-photos bucket.
-- This function deletes database rows in one transaction and is executable only by service_role.

create or replace function public.delete_conect_account_data(p_profile_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_profile_id is null then
    raise exception 'A profile ID is required';
  end if;

  -- Remove conversation content before its match rows.
  delete from public.messages
  where match_id in (
    select id from public.matches
    where user_a = p_profile_id or user_b = p_profile_id
  );

  delete from public.matches
  where user_a = p_profile_id or user_b = p_profile_id;

  delete from public.swipes
  where from_user_id = p_profile_id or to_user_id = p_profile_id;

  delete from public.blocks
  where blocker_user_id = p_profile_id or blocked_user_id = p_profile_id;

  delete from public.profile_visits
  where visitor_user_id = p_profile_id or visited_user_id = p_profile_id;

  -- Account erasure removes reports linked to the deleted profile.
  -- Review a formal moderation-record retention policy before public launch.
  delete from public.reports
  where reporter_user_id = p_profile_id or reported_user_id = p_profile_id;

  delete from public.profile_interests
  where user_id = p_profile_id;

  delete from public.profile_photos
  where user_id = p_profile_id;

  delete from public.profiles
  where id = p_profile_id;

  return jsonb_build_object('ok', true, 'deleted', true);
end;
$$;

revoke all on function public.delete_conect_account_data(uuid) from public, anon, authenticated;
grant execute on function public.delete_conect_account_data(uuid) to service_role;
