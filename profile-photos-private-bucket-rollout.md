# Conect profile-photo privacy rollout

Status: the `telegram-session` Edge Function is deployed and active at version 26. The frontend scroll fix is committed (preview cache-buster `?v=f476ab5`) and needs a live retest. The `profile-photos` bucket is still public; do not switch it until all app checks below pass.

## Why this must be done in order

The updated frontend expects profile-photo URLs to be time-limited signed links. The updated telegram-session Edge Function creates one-hour signed URLs for profile photos and can renew them when the frontend detects a failed/expired image URL. Deploy and test both before changing the bucket.

Supabase documents private buckets as requiring an authorized request or a time-limited signed URL. Use the Supabase Dashboard to change the bucket's public/private setting rather than directly updating Supabase's managed storage schema with SQL.

## Rollout steps

1. Open the latest GitHub Pages preview with a fresh cache-buster, e.g. `?v=f476ab5`, and confirm the new frontend loads.
2. Confirm Supabase Dashboard → Edge Functions → `telegram-session` shows the already-deployed version 26 as active. If the backend source has changed since that deployment, deploy the current `telegram-session-with-messaging-v3.ts` source while keeping the existing function name and project secrets.
3. While the bucket is still public, test your own profile photo and gallery, Discover cards, Likes/Matches, username search, profile visits, and Blocked users. Also open a person's full profile by tapping their icon in a chat and verify you can scroll all the way down and use the visible options. If any photo or profile detail fails, stop and fix it before continuing.
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
