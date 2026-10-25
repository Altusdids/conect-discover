# Conect beta moderation and safety runbook

Internal working procedure — review before each beta expansion.

## Current system facts
- The frontend supports blocking and submitting a report.
- The backend validates report reasons and inserts reports into the Supabase `reports` table.
- Report reasons currently include fake profile, harassment, spam, inappropriate content, suspected underage user, and other.
- The app does not currently expose a dedicated moderator dashboard or a published response-time commitment.
- **Live production status:** the deployed account-deletion workflow currently deletes report rows linked to the deleted account.
- **Staged proposal only:** branch beta-safety-report-retention contains a migration that makes report profile references nullable, clears the deleted profile's direct reference, timestamps report closure, and adds a manual purge function for closed reports older than 12 months. This change is NOT live until it has been reviewed, tested in a non-production environment, and deliberately deployed.
- The proposed retained record can still include user-submitted free text that identifies someone. Moderators must restrict access and redact information that is not necessary for safety review.

## Access and ownership
1. Name a primary moderator and backup moderator before inviting beta users.
2. Limit Supabase project access to people who need it. Do not expose service-role keys or database credentials in the app.
3. Use the Supabase dashboard to review the `reports` table. Never paste private report details into a public issue or shared chat.
4. Keep a simple incident log with report ID, timestamp, assigned moderator, action, and closure date. Avoid copying unnecessary personal data into the log.

## Suggested review cadence and priorities
- Review new reports at least once each day during the beta. If the team cannot provide this coverage, reduce invitations and communicate that reports are not continuously monitored.
- **Priority 1:** suspected underage user, credible threats, sexual exploitation, non-consensual intimate imagery, extortion/blackmail, imminent danger. Restrict exposure where appropriate, preserve only necessary evidence, escalate to the responsible operator, and consider lawful reporting obligations. Do not promise emergency response.
- **Priority 2:** targeted harassment, impersonation, scams, repeated unwanted contact, intimate privacy violations.
- **Priority 3:** spam, misleading profiles, inappropriate non-urgent content, and other community issues.

Suggested beta objective (not a current promise): acknowledge high-risk reports within 24 hours and routine reports within 3 days, provided moderators are actually staffed to meet it. Do not publish these targets until the operator accepts ownership and monitoring coverage exists.

## Handling a report
1. Open the report record and inspect the reason, details, target account, reporter account, timestamp and status.
2. Review only information necessary to assess the reported conduct. Avoid accessing unrelated private conversations unless needed and lawfully available.
3. Check for repeat reports or related block history, while treating report volume as a signal rather than proof.
4. Choose and record a proportionate action: no action with reason, warning, content/profile restriction, temporary suspension, account disablement, or escalation for legal/safety advice. The current UI does not automate these actions; apply them only through approved admin procedures.
5. Update the report status if the schema supports it, note the outcome, and close the internal incident log item.
6. Avoid retaliation against the reporter. Do not disclose a reporter’s identity to the reported member except where legally required and approved.
7. If a report is ambiguous, ask for only the minimum additional information needed through an official, private contact channel.

## Blocking and emergencies
- Blocking should prevent ordinary discovery/matching/contact as implemented. When reviewing a complaint, confirm the blocker is not made visible to the blocked person.
- Conect is not an emergency-response service. Direct imminent threats to local emergency services or relevant local support.
- Do not ask a user to confront the alleged offender.

## Account deletion and evidence retention
- Until the staged migration is tested and deployed, production still deletes report rows linked to an account that is deleted.
- Proposed beta behaviour: keep a limited report record, null the direct reference to any deleted profile, and retain the report reason/details/status/timestamps only for safety review. This is pseudonymisation, not guaranteed anonymisation; free-text details may identify people and must be redacted when unnecessary.
- Closed reports receive a closed_at timestamp and are eligible for deletion 12 months after that recorded date. Existing closed records with no historical timestamp are assigned the rollout date. Reopened reports clear the closure timestamp.
- Review open/reviewing cases at least monthly for continued necessity. Run select public.purge_expired_conect_reports(); from the Supabase SQL Editor at least monthly once the migration is deployed; review the returned number and confirm only expired closed reports were removed. No automated purge schedule is installed by the staged migration.
- Run the rollback-only safety-report-retention-test.sql against a non-production environment after applying the migration. Do not test by deleting an account that contains data you want to keep.
- Confirm this retention exception and its necessity with the responsible legal/privacy reviewer before broad public launch.

## Operational prerequisites before public launch
- Publish operator name, address and a monitored privacy/safety contact.
- Confirm retention windows for live records, provider backups and logs.
- Complete the privacy policy and photo visibility decision.
- Confirm current PDPO registration requirements and complete any required registration.
- Test blocking, report submission, report review access, account deletion, and cross-account isolation using disposable test accounts.
- Establish a process for data-access/correction/deletion requests and a data-incident response.
- Review this runbook with the person responsible for moderation and record approval.
