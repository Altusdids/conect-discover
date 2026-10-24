# Conect launch-readiness audit

_Last updated: 2026-10-24_

## Changes added to the preview repository

- Added a **Delete account permanently** control under Profile with a browser confirmation and a second typed `DELETE` confirmation.
- Added a `delete_account` Edge Function action. It verifies the caller via signed Telegram Mini App `initData` and finds the profile using the verified Telegram user ID; it does not accept a profile ID from the browser.
- The Edge Function removes profile photo objects from the `profile-photos` Storage bucket, then calls a database function to clean relational records.
- Added a PostgreSQL migration defining `public.delete_conect_account_data(uuid)`. It removes messages for the account's matches, match rows, swipes, blocks, profile visits, reports, interests, photo rows, and finally the profile in one database transaction. The RPC is executable only by `service_role`.
- On successful deletion, the frontend clears app-local profile, likes, passes, matches, chat state, and returns to the profile-creation screen.
- Added a global user-facing error banner for uncaught JavaScript errors and unhandled promise rejections. Individual operations still show their specific error text where available.
- The earlier account-isolation fix records the Telegram profile owner in local storage, clears unowned/mismatched cached profile state at verification, and replaces local profile state with data returned for the verified account.

## Required deployment order — not yet verified in production

1. In the Supabase SQL Editor, run `profile-account-deletion-migration.sql`.
2. Verify the query succeeds.
3. Update and deploy the Supabase `telegram-session` Edge Function using `telegram-session-with-messaging-v3.ts` from this repository.
4. Open the GitHub Pages preview and confirm the new delete control appears.
5. Test account deletion only with a **disposable test account**. Never use an account containing data you want to keep.
6. Verify the test account disappears from discovery and its old matches, messages, likes, visits, blocks, report rows, and photo objects are cleaned up. Confirm another user's account and gallery remain unchanged.

Do not test the new delete control before steps 1–3. The frontend is committed, but account deletion will fail until the SQL function and Edge Function update are deployed.

## Remaining privacy and safety decisions before a broader launch

- **Photo URL access:** current profile responses use Supabase Storage public URLs. Treat profile photos as public to anyone who obtains the URL. If photos must be accessible only through Conect, migrate to a private bucket and short-lived signed URLs, then update all photo-returning backend actions and frontend refresh handling.
- **Report retention:** this deletion implementation deletes reports linked to the deleted account. Decide and document a moderation/legal retention policy before launch; if reports must be retained, anonymize the account association rather than deleting all evidence.
- **Data inventory:** confirm whether the Supabase project has any additional user-linked tables beyond the tables used by this Edge Function. Add those relations to the deletion transaction before launch.
- **User-facing error copy:** the new banner covers uncaught runtime failures; continue testing network, upload, message, report, and profile-save failures on real devices.
- **Pending two-account coverage:** chat requests and discovery filters remain unverified because more suitable test accounts are needed.
- **Operational safeguards:** add abuse/rate-limit monitoring, a moderation process for submitted reports, and a public privacy policy/account deletion explanation before inviting a broad audience.

## What the code already checks

- Telegram `initData` is signature-checked on the server, with an age limit.
- The backend derives the acting profile from the verified Telegram ID rather than trusting a client-provided owner ID.
- The saved email is returned by the self-profile load action, not included in discovery cards or normal public profile summaries.
- Discovery and messaging check blocking state on the server.
- Message length, photo size/type, interest count, profile age, and profile fields receive server-side validation.

## Rollback / recovery note

Account deletion is intentionally permanent. A database failure after Storage removal can leave the account row present but its images removed; the UI reports this rather than claiming success. Retry or administrator review may be required if Supabase returns a partial-cleanup error.
