# Conect profile-photo privacy rollout

Status: source changes are committed; **not yet deployed**. The profile-photos bucket is still public until the dashboard switch below is completed.

## Why this must be done in order

The updated frontend expects profile-photo URLs to be time-limited signed links. The updated telegram-session Edge Function creates one-hour signed URLs for profile photos and can renew them when the frontend detects a failed/expired image URL. Deploy and test both before changing the bucket.

Supabase documents private buckets as requiring an authorized request or a time-limited signed URL. Use the Supabase Dashboard to change the bucket's public/private setting rather than directly updating Supabase's managed storage schema with SQL.

## Rollout steps

1. Publish the updated index_live_matching_preview.html from GitHub Pages. Open the preview with a new query string, e.g. ?v=c2d6e69, and confirm it loads.
2. In Supabase Dashboard → Edge Functions → telegram-session, deploy the current source file telegram-session-with-messaging-v3.ts from this repository. Keep the existing function name and project secrets.
3. While the bucket is still public, test your own profile photo and gallery, Discover cards, Likes/Matches, username search, profile visits, and Blocked users. Confirm all profile photos still load. If any do not, stop and fix before continuing.
4. In Supabase Dashboard → Storage → Buckets → profile-photos, open the bucket's action menu and choose Make private (wording may vary).
5. Verify the setting with this read-only query:

   SELECT id, name, public
   FROM storage.buckets
   WHERE id = 'profile-photos';

   Expected result: public = false.

6. Test that direct public object URLs are denied and that images still load inside Conect through signed URLs. Test on desktop and Android, then wait for an hour or use an expired/stale photo URL scenario to confirm the frontend can refresh it. Never paste signed URLs into public chats; anyone holding a signed URL may use it until its validity/cache window ends.
7. Only after these checks pass, update the public Privacy Policy wording from the current-public-URL note to the verified private-bucket behavior.

## Safety notes

- The read-only policy preflight found profile-photos is public and no SELECT/ALL policies on storage.objects were returned. The Edge Function uses the server secret to create signed URLs, so normal app users should not need direct Storage read policies.
- Do not run SQL UPDATE statements against storage.buckets or storage.objects for this rollout. Use the dashboard's bucket privacy control.
- Changing the bucket does not delete files, but it cannot recall images or copies already downloaded, shared, or captured while the bucket was public. CDN/browser caching can delay observed behavior, so test with a fresh direct URL and a unique query string.
- If photo loading fails after switching to private, pause other rollout changes and use the Edge Function logs to diagnose before choosing whether to temporarily restore public access.
