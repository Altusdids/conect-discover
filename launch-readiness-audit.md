# Conect launch-readiness audit

_Last updated: 2026-10-25_

## Changes added to the preview repository

- Added a **Delete account permanently** control under Profile with a browser confirmation and a second typed `DELETE` confirmation.
- Added a `delete_account` Edge Function action. It verifies the caller via signed Telegram Mini App `initData` and finds the profile using the verified Telegram user ID; it does not accept a profile ID from the browser.
- The Edge Function removes profile photo objects from the `profile-photos` Storage bucket, then calls a database function to clean relational records.
- Added a PostgreSQL migration defining `public.delete_conect_account_data(uuid)`. It removes messages for the account's matches, match rows, swipes, blocks, profile visits, reports, interests, photo rows, and finally the profile in one database transaction. The RPC is executable only by `service_role`.
- On successful deletion, the frontend clears app-local profile, likes, passes, matches, chat state, and returns to the profile-creation screen.
- Added a global user-facing error banner for uncaught JavaScript errors and unhandled promise rejections. Individual operations still show their specific error text where available.
- Prepared private profile-photo delivery in source: all identified backend photo responses use one-hour signed URLs, and a verified refresh action renews expired links. The frontend retries a failed signed or legacy public photo URL once. Deployment and bucket migration are still pending.
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

- **Photo URL access — code prepared, not yet deployed:** backend source now signs profile-photo URLs for one hour on every identified response path and provides a checked refresh action; the frontend retries a failed signed or legacy public photo URL once. This does not make photos private until the Edge Function and frontend are deployed and the `profile-photos` bucket is set private. Run the policy preflight SQL, inspect all SELECT/ALL policies on `storage.objects`, and only then prepare/apply the bucket migration. Public URLs that were already shared or cached cannot be assumed to be retroactively revoked.
- **Report retention:** this deletion implementation deletes reports linked to the deleted account. Decide and document a moderation/legal retention policy before launch; if reports must be retained, anonymize the account association rather than deleting all evidence.
- **Data inventory:** confirm whether the Supabase project has any additional user-linked tables beyond the tables used by this Edge Function. Add those relations to the deletion transaction before launch.
- **User-facing error copy:** the new banner covers uncaught runtime failures; continue testing network, upload, message, report, and profile-save failures on real devices.
- **Pending coverage:** chat-request flow and additional failure-path/device tests remain unverified; discovery filters, mutual matching, attachments, message actions, reporting, blocking and account deletion have been manually tested by the operator.
- **Operational safeguards:** add abuse/rate-limit monitoring, a moderation process for submitted reports, and a public privacy policy/account deletion explanation before inviting a broad audience.

## What the code already checks

- Telegram `initData` is signature-checked on the server, with an age limit.
- The backend derives the acting profile from the verified Telegram ID rather than trusting a client-provided owner ID.
- The saved email is returned by the self-profile load action, not included in discovery cards or normal public profile summaries.
- Discovery and messaging check blocking state on the server.
- Message length, photo size/type, interest count, profile age, and profile fields receive server-side validation.

## Rollback / recovery note

Account deletion is intentionally permanent. A database failure after Storage removal can leave the account row present but its images removed; the UI reports this rather than claiming success. Retry or administrator review may be required if Supabase returns a partial-cleanup error.


## Launch essentials — drafted 24 October 2026

### Added to the repository
- `privacy-policy.html`: user-facing privacy policy draft, linked from More → Settings & help. Operator name (`SS Tulsa Stephen`), public contact/business address (`7G2P+GG Kampala`) and privacy/support email (`tulsa22nd@gmail.com`) have been added; verify the address is appropriate to publish and the email is working and monitored.
- `community-guidelines.html`: age-18+ rule, consent, anti-harassment/scam rules, reporting guidance and safety reminders.
- `account-deletion.html`: explains the in-app deletion steps, what the current deletion workflow removes, and limitations around backups and partial failures.
- `profile-photos-private-bucket-preflight.sql`: read-only inventory of the current profile-photo bucket and storage read policies before preparing the privacy migration.
- `moderation-runbook.md`: internal beta procedure for triaging reports, reviewing the Supabase reports table manually, and handling urgent safety matters.
- Updated Settings & help to link all three public pages.

### Must be resolved before inviting a broad public audience
- **Operator contact verification:** the supplied operator name, address and privacy/support email are now present in the policy. Verify the address is appropriate for public disclosure and that `tulsa22nd@gmail.com` is working and monitored. Do not treat the policy as final until the remaining items below are resolved.
- **Uganda PDPO registration:** confirm the operator's registration obligations and complete required registration. Government guidance currently states the requirement applies broadly to persons/entities collecting or processing personal data.
- **Retention schedule:** set and disclose retention periods for active records, provider backups and security logs. The code does not establish a complete documented retention schedule yet.
- **Photo privacy migration:** code is prepared but not deployed. The bucket remains public until the storage-policy preflight is reviewed and an approved migration sets it private. Do not mark photo privacy as solved until backend/frontend deployment and private-access tests pass.
- **Report evidence policy:** current account deletion removes report rows linked to the deleted account. Decide whether limited safety evidence needs restricted/anonymised retention, then implement the decision and update the policy before launch.
- **Moderator staffing:** report submission exists, but there is no dedicated moderator dashboard or implemented response-time promise. Assign a moderator and backup, review reports manually during the beta, and do not publish service-level targets until they can be met.
- **Legal review:** have the responsible operator review the public drafts for the real business setup, processing locations and legal obligations. These files are operational drafts, not legal advice or a certification of compliance.

### Important scope note
The privacy, community and deletion pages are linked from the app. Operator details have been entered in the privacy policy. Profile-photo privacy source changes are committed but have not yet been deployed; the bucket remains unchanged until storage policies are reviewed and the migration is applied. The policy remains a pre-launch draft until contact verification and the remaining decisions above are completed.
