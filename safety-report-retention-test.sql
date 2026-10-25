-- Conect safety-report retention test.
-- Run ONLY after safety-report-retention-migration.sql is applied to a test/staging
-- database. This script uses synthetic accounts and ends with ROLLBACK.
-- Do not remove the final ROLLBACK or run against production data without a reviewed plan.

BEGIN;

DO $test$
DECLARE
  deleted_profile uuid;
  surviving_profile uuid;
  other_profile uuid;
  deleted_reporter_report uuid;
  deleted_target_report uuid;
  expired_report uuid;
  closed_stamp timestamptz;
  purged_count integer;
  suffix text := substr(replace(gen_random_uuid()::text, '-', ''), 1, 8);
BEGIN
  INSERT INTO public.profiles
    (telegram_user_id, app_username, display_name, age, gender, interested_in,
     show_me, country, city, bio, purpose)
  VALUES
    (900000000000000101, 'ret_a_' || suffix, 'Retention Test A', 25, 'Male', 'Any',
     'Any', 'Test Country', 'Test City', '', 'both')
  RETURNING id INTO deleted_profile;

  INSERT INTO public.profiles
    (telegram_user_id, app_username, display_name, age, gender, interested_in,
     show_me, country, city, bio, purpose)
  VALUES
    (900000000000000102, 'ret_b_' || suffix, 'Retention Test B', 27, 'Female', 'Any',
     'Any', 'Test Country', 'Test City', '', 'both')
  RETURNING id INTO surviving_profile;

  INSERT INTO public.profiles
    (telegram_user_id, app_username, display_name, age, gender, interested_in,
     show_me, country, city, bio, purpose)
  VALUES
    (900000000000000103, 'ret_c_' || suffix, 'Retention Test C', 29, 'Non-binary', 'Any',
     'Any', 'Test Country', 'Test City', '', 'both')
  RETURNING id INTO other_profile;

  INSERT INTO public.reports
    (reporter_user_id, reported_user_id, reason, details, status)
  VALUES
    (deleted_profile, surviving_profile, 'harassment', 'Synthetic test report A', 'open')
  RETURNING id INTO deleted_reporter_report;

  INSERT INTO public.reports
    (reporter_user_id, reported_user_id, reason, details, status)
  VALUES
    (surviving_profile, deleted_profile, 'underage_suspicion', 'Synthetic test report B', 'resolved')
  RETURNING id INTO deleted_target_report;

  SELECT closed_at INTO closed_stamp
  FROM public.reports
  WHERE id = deleted_target_report;

  IF closed_stamp IS NULL THEN
    RAISE EXCEPTION 'FAIL: a resolved report did not receive closed_at';
  END IF;

  INSERT INTO public.reports
    (reporter_user_id, reported_user_id, reason, details, status, closed_at)
  VALUES
    (surviving_profile, other_profile, 'spam', 'Synthetic expired report', 'resolved',
     now() - interval '13 months')
  RETURNING id INTO expired_report;

  PERFORM public.delete_conect_account_data(deleted_profile);

  IF EXISTS (SELECT 1 FROM public.profiles WHERE id = deleted_profile) THEN
    RAISE EXCEPTION 'FAIL: the deleted test profile still exists';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.reports
    WHERE id = deleted_reporter_report
      AND reporter_user_id IS NULL
      AND reported_user_id = surviving_profile
  ) THEN
    RAISE EXCEPTION 'FAIL: report from deleted reporter was not retained and unlinked';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.reports
    WHERE id = deleted_target_report
      AND reported_user_id IS NULL
      AND reporter_user_id = surviving_profile
      AND closed_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'FAIL: report against deleted target was not retained and unlinked';
  END IF;

  SELECT public.purge_expired_conect_reports() INTO purged_count;

  IF NOT EXISTS (SELECT 1 FROM public.reports WHERE id = deleted_reporter_report) THEN
    RAISE EXCEPTION 'FAIL: open report was purged unexpectedly';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.reports WHERE id = deleted_target_report) THEN
    RAISE EXCEPTION 'FAIL: recently closed report was purged unexpectedly';
  END IF;

  IF EXISTS (SELECT 1 FROM public.reports WHERE id = expired_report) THEN
    RAISE EXCEPTION 'FAIL: report closed over 12 months ago was not purged';
  END IF;

  RAISE NOTICE 'PASS: account profile was deleted; direct report links were nulled; reports were retained; expired closed report was purged (purged count %)', purged_count;
END;
$test$;

ROLLBACK;
