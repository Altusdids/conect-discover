-- Conect: make profile-photo storage private.
-- Apply only AFTER deploying the matching telegram-session Edge Function and
-- frontend code that generate and refresh signed photo URLs.
--
-- This migration intentionally stops if it finds any SELECT/ALL read policy
-- for anon/authenticated/public on storage.objects, so unexpected access rules
-- are reviewed instead of silently changing them. It does not delete files
-- or change profile_photos rows.

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM storage.buckets WHERE id = 'profile-photos'
  ) THEN
    RAISE EXCEPTION 'The profile-photos bucket does not exist; migration stopped.';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_policies AS p
    WHERE p.schemaname = 'storage'
      AND p.tablename = 'objects'
      AND p.cmd IN ('SELECT', 'ALL')
      AND (
        p.roles && ARRAY['anon'::name, 'authenticated'::name, 'public'::name]
      )
  ) THEN
    RAISE EXCEPTION
      'A SELECT/ALL policy applies to anon, authenticated, or public on storage.objects. Review the policy before making profile-photos private.';
  END IF;
END;
$$;

UPDATE storage.buckets
SET public = false
WHERE id = 'profile-photos';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM storage.buckets
    WHERE id = 'profile-photos'
      AND public = false
  ) THEN
    RAISE EXCEPTION 'Could not verify profile-photos is private; migration stopped.';
  END IF;
END;
$$;

COMMIT;

-- Read-only verification:
SELECT id, name, public
FROM storage.buckets
WHERE id = 'profile-photos';
