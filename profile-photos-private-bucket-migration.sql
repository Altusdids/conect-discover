-- Conect: make profile photo objects private.
-- IMPORTANT: deploy and verify the signed-URL Edge Function and frontend first.
-- Apply only after the read-only policy preflight has been reviewed.
-- This updates the bucket visibility flag; it does not delete or move files.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM storage.buckets WHERE id = 'profile-photos'
  ) THEN
    RAISE EXCEPTION 'Expected storage bucket profile-photos was not found; no change applied';
  END IF;

  UPDATE storage.buckets
  SET public = false
  WHERE id = 'profile-photos';
END;
$$;

-- Verify the result separately after applying the migration:
-- SELECT id, name, public FROM storage.buckets WHERE id = 'profile-photos';
-- Expected: one row with public = false.
