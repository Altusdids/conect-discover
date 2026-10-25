-- Conect profile-photo privacy preflight (READ ONLY)
-- Run this in Supabase SQL Editor before changing the profile-photos bucket.
-- It does not modify any bucket, policy, file, or database row.
--
-- Review EVERY returned SELECT/ALL policy. A policy scoped to profile-photos,
-- or a broad policy that permits anon/public reads of storage.objects, may
-- still allow direct object access even after the bucket is marked private.
-- We will prepare the exact migration only after the current policy names and
-- expressions have been reviewed.

SELECT
    b.id AS bucket_id,
    b.name AS bucket_name,
    b.public AS bucket_is_public,
    p.policyname,
    p.permissive,
    p.roles,
    p.cmd AS policy_command,
    p.qual AS using_expression,
    p.with_check AS with_check_expression
FROM storage.buckets AS b
LEFT JOIN pg_policies AS p
    ON p.schemaname = 'storage'
   AND p.tablename = 'objects'
   AND p.cmd IN ('SELECT', 'ALL')
WHERE b.id = 'profile-photos'
ORDER BY p.policyname NULLS FIRST;
