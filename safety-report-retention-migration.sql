-- Conect beta safety-report retention policy.
-- STAGE ONLY: review and test in a non-production environment before applying.
-- Retains minimal report rows when a linked account is deleted by nulling that
-- account's direct profile references. The remaining report detail is restricted
-- to administrators and should be redacted when personally identifying text is
-- not needed. Closed reports can be purged 12 months after recorded closure.

ALTER TABLE public.reports
  ALTER COLUMN reporter_user_id DROP NOT NULL,
  ALTER COLUMN reported_user_id DROP NOT NULL;

-- Reports are written through the server-side Edge Function and are reviewed by
-- the project operator. Do not expose report rows directly to app client roles.
REVOKE ALL ON TABLE public.reports FROM anon, authenticated;

ALTER TABLE public.reports
  ADD COLUMN IF NOT EXISTS closed_at timestamptz;

COMMENT ON COLUMN public.reports.closed_at IS
  'Timestamp the report was resolved or dismissed; closed records are eligible for deletion after 12 months.';

COMMENT ON COLUMN public.reports.details IS
  'User-submitted report details. May contain personal information; restrict access and redact details not needed for safety review.';

-- Historical closed rows did not have a closure timestamp. Start the transition
-- period at rollout, rather than guessing an earlier closure date that was never recorded.
UPDATE public.reports
SET closed_at = now()
WHERE status IN ('resolved', 'dismissed')
  AND closed_at IS NULL;

CREATE OR REPLACE FUNCTION public.set_conect_report_closed_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $function$
BEGIN
  IF NEW.status IN ('resolved', 'dismissed') THEN
    IF TG_OP = 'INSERT' THEN
      NEW.closed_at := COALESCE(NEW.closed_at, now());
    ELSIF OLD.status NOT IN ('resolved', 'dismissed') THEN
      NEW.closed_at := COALESCE(NEW.closed_at, now());
    ELSE
      -- Preserve the original close date while a report stays closed.
      NEW.closed_at := COALESCE(OLD.closed_at, NEW.closed_at, now());
    END IF;
  ELSE
    -- Reopened/in-progress reports are not on the closed-record retention clock.
    NEW.closed_at := NULL;
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS set_conect_report_closed_at ON public.reports;
CREATE TRIGGER set_conect_report_closed_at
BEFORE INSERT OR UPDATE OF status, closed_at
ON public.reports
FOR EACH ROW
EXECUTE FUNCTION public.set_conect_report_closed_at();

-- Account deletion still erases normal account, relationship, message, and media
-- records. It preserves report evidence but removes direct links to the deleted
-- profile. This is pseudonymisation, not a guarantee that free-text details are
-- fully anonymous; administrators must minimise/redact those details as appropriate.
CREATE OR REPLACE FUNCTION public.delete_conect_account_data(p_profile_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  IF p_profile_id IS NULL THEN
    RAISE EXCEPTION 'A profile ID is required';
  END IF;

  -- Remove conversation content before its match rows.
  DELETE FROM public.messages
  WHERE match_id IN (
    SELECT id FROM public.matches
    WHERE user_a = p_profile_id OR user_b = p_profile_id
  );

  DELETE FROM public.matches
  WHERE user_a = p_profile_id OR user_b = p_profile_id;

  DELETE FROM public.swipes
  WHERE from_user_id = p_profile_id OR to_user_id = p_profile_id;

  DELETE FROM public.blocks
  WHERE blocker_user_id = p_profile_id OR blocked_user_id = p_profile_id;

  DELETE FROM public.profile_visits
  WHERE visitor_user_id = p_profile_id OR visited_user_id = p_profile_id;

  -- Keep the minimum existing safety report record, but remove direct FKs to the
  -- deleted account. Rows cannot identify the deleted account through these columns.
  UPDATE public.reports
  SET reporter_user_id = CASE
        WHEN reporter_user_id = p_profile_id THEN NULL
        ELSE reporter_user_id
      END,
      reported_user_id = CASE
        WHEN reported_user_id = p_profile_id THEN NULL
        ELSE reported_user_id
      END
  WHERE reporter_user_id = p_profile_id
     OR reported_user_id = p_profile_id;

  DELETE FROM public.profile_interests
  WHERE user_id = p_profile_id;

  DELETE FROM public.profile_photos
  WHERE user_id = p_profile_id;

  DELETE FROM public.profiles
  WHERE id = p_profile_id;

  RETURN jsonb_build_object('ok', true, 'deleted', true);
END;
$function$;

REVOKE ALL ON FUNCTION public.delete_conect_account_data(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.delete_conect_account_data(uuid)
  TO service_role;

-- Call this manually from the Supabase SQL Editor at least monthly during beta.
-- No automated schedule is installed by this migration.
CREATE OR REPLACE FUNCTION public.purge_expired_conect_reports()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  deleted_count integer;
BEGIN
  DELETE FROM public.reports
  WHERE closed_at IS NOT NULL
    AND closed_at <= now() - interval '12 months';

  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$function$;

REVOKE ALL ON FUNCTION public.purge_expired_conect_reports()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.purge_expired_conect_reports()
  TO service_role;
