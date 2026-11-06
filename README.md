# Dispatch backend

NestJS + TypeScript API, PostgreSQL storage, Redis/BullMQ delivery worker, Amazon SES sending and SQS event ingestion. The modern admin API under `/api/v1/manage` matches the product frontend. The original `/api/v1` foundation routes remain available for compatibility.

## Current revision status

Source code only: the new implementation has NOT been built, type-checked, tested, started, or migrated, as requested. It requires migrations `001_foundation.sql`, `002_product.sql`, and `003_accounts_operations.sql`. Existing databases must apply every outstanding migration before the updated API/worker can be used. Stop old workers during this schema upgrade. No provider resources were created and no emails were sent while making these edits.

## Setup for later execution

Prerequisites: Node 22.22.3+, PostgreSQL, Redis, or Docker with a running Linux engine. Keep the independent frontend repository beside this directory as `../frontend`.

```sh
npm ci
npm run setup
docker compose up -d postgres redis
npm run migrate
npm run dev
```

Run `npm run dev:worker` separately. Run the sibling frontend with `npm run dev`, open http://localhost:5173, and enter API_KEY from this backend's ignored `.env`. Setup generates distinct random secrets and never overwrites an existing `.env`.

For the combined local stack: `docker compose up --build -d`, then visit http://localhost:8080. The migration service applies outstanding SQL files before the API/worker start. These commands are instructions for later; none were executed for this revision.

SEND_MODE defaults to dry-run. API process liveness is `/health`; endpoint discovery is `/docs`. Request bodies are validated with Zod. Swagger body schemas are not generated from those schemas; use the frontend and `src/product/schemas.ts` as the current request contract.

## Admin API

All `/api/v1/manage/*` routes require an account session or X-API-Key with the server's administrator key. Cookie-authenticated writes also require X-Dispatch-CSRF; the frontend handles it. JSON bodies use Content-Type: application/json. GET/POST/PATCH/DELETE are supported as appropriate.

| Resource | Actions |
| --- | --- |
| contacts | Paginated GET (search/status/listId/tagId/segmentId/page/pageSize), create, edit, archive |
| contacts/bulk | POST ids + archive/list/tag action and optional targetId |
| contacts/:id/unsubscribe | Record opt-out and protected suppression |
| contacts/import | POST csv, consentSource, optional listId, dryRun; preview or transactional import |
| lists | Membership/eligible counts, create, edit, guarded delete |
| tags / fields | Tag management and custom-field definitions |
| segments | Create/edit/delete typed all-match rules; segments/preview returns matching count |
| templates | HTML + design JSON create/edit/delete |
| campaigns | Draft create/edit/delete, list statistics, duplicate, eligible audience and message log |
| campaigns/:id/action | send / schedule / pause / resume / cancel; schedule includes scheduledAt ISO datetime |
| reports | Period summaries, daily series, campaign statistics and tracked links |
| reports/export | Authenticated CSV download with spreadsheet-formula-safe cells |
| automations | Workflow definitions, activation/pause, manual enrollment and enrollment history |
| forms | Signup/landing-page definitions, publishing, URLs and confirmation counts |
| transactional / transactional/send | Recent messages and admin message composer |
| test-send | Admin test message, using the same configured delivery mode |
| suppressions | List/add; suppressions/remove can only remove manual records |
| settings | Workspace name/company/postalAddress/timezone/replyTo/trackingEnabled |
| domains | POST domain + create boolean: SES identity create or status/DKIM refresh |
| keys | Generate one-time visible transactional secrets; revoke by ID |
| activity | Recent email events |

Contact email addresses are stable identifiers: edit profile details in place; create a different contact for a different email to preserve consent and delivery history. Archive retains history. CSV updates retain existing subscription/suppression status and merge list/tag membership.

Segment rules contain field, operator and value. Allowed fields: email, first_name, status, score, tag, or fields.<custom_key>. Operators: equals, contains, greater_than, less_than. Tags support equals only. Rules compile into parameterized SQL; arbitrary SQL/JSON paths are not accepted.

## Transactional integration

Create a key in Settings -> API keys. Keys are stored as SHA-256 hashes and authorize only POST `/api/v1/send`.

```json
{
  "to": "customer@example.com",
  "subject": "Your order is confirmed",
  "html": "<h1>Thank you, {{first_name}}</h1>",
  "variables": {"first_name":"Ada"},
  "idempotencyKey": "order-123-confirmation"
}
```

Use X-API-Key with the generated transactional secret. The response includes the message UUID and queue status. Reusing the same key/content returns the same message; changed content returns 409. Keys are namespaced per integration. Suppressed recipients are rejected. Creating a transactional recipient does not subscribe them to marketing.

## Sending and scheduling

The worker prepares frozen campaign recipient snapshots when a queued campaign is dispatched or a scheduled campaign becomes due. PostgreSQL message rows are the durable outbox. Stable BullMQ job IDs, rate limiting, delayed jobs, and retries cover queue/infrastructure interruptions. Paused workflows/campaigns defer pending jobs; cancel excludes queued messages. An in-flight provider request cannot be recalled.

SES SDK automatic retries are disabled for send calls: SES has no send idempotency key. Ambiguous failures become unknown and must be reviewed; a crash after claiming can leave sending rows. Do not reset these rows without reconciling against provider events. Completed means queue processing ended, including suppressed/failed/unknown outcomes; always inspect counts. A dry-run campaign is not replayed live: duplicate into a new draft.

Merge values are HTML escaped; subjects strip CR/LF. Reserved company, postal_address and unsubscribe_url values come from workspace/server state. Contact first_name/email are defaults and explicit transactional variables can override personalization values. Use non-reserved custom keys for recipient-specific company details. Campaign preview text is inserted as a hidden preheader. Live marketing sends require company/postal address and an unsubscribe tag.

Signed unsubscribe GET shows a designed confirmation page; POST records the opt-out. The stable UNSUBSCRIBE_SECRET also signs tracking links. Rotating it invalidates prior recipient links. Open/click tracking requires workspace permission plus per-campaign opt-in; only live-sent messages can produce tracked events. Click targets are stored server-side and signed rather than accepting arbitrary destination parameters. Open metrics can include privacy-tool activity.

## Workflows

Automations support manual, list_join, tag_added, and confirmed form_submitted triggers. Each contact enters each automation once. Enrollment snapshots contain ordered steps: email template, delay in minutes, add tag, adjust score, condition (one typed rule with optional yes/no step IDs), end. The worker commits one step at a time under row locks and persists due timestamps. Paused workflows suspend later processing. Cycles are capped at 1,000 executions per enrollment. Failed enrollments retain an error for review. Template content is copied when an email step is reached; queued messages retain their copy.

## Public signup and tracking routes

- GET/POST `/public/forms/:slug`: published branded signup experiences; honeypot and database-backed hourly IP/email limits.
- GET/POST `/public/confirm?token=...`: one-time, hashed, 24-hour double-opt-in token. GET does not mutate state.
- GET `/track/open/:id?token=...` and `/track/click/:id?token=...`: signed tracking handlers.
- GET/POST `/unsubscribe/:id?token=...`: signed opt-out confirmation and one-click handler.

Confirmed signups add list membership and trigger workflows. They can clear an unsubscribe suppression but cannot override bounce/complaint/manual suppressions. Dry-run confirmation messages are logged without delivery, so real public signup completion requires working SES delivery. Public forms are controlled signup layouts; landing pages currently use the same branded signup composition, not a general website builder.

## SES and deployment

Verify the sender identity in AWS_REGION; configure DKIM, SPF/custom MAIL FROM, and DMARC. Set SES_FROM_EMAIL, SES_CONFIGURATION_SET and PUBLIC_API_URL. Enable SES production access where needed. Use a server IAM role/default AWS credential chain; no AWS secret belongs in the frontend. Identity management UI needs ses:CreateEmailIdentity and ses:GetEmailIdentity in addition to ses:SendEmail.

Configure SES -> SNS -> SQS for delivery, bounce and complaint events. Restrict the SQS queue policy to the intended SNS source ARN and configure a dead-letter queue. The worker supports raw/SNS-wrapped events, deduplicates receipt IDs, associates dispatch message tags/provider IDs with delivery history, and suppresses permanent bounces/complaints. SQS polling needs sqs:ReceiveMessage and sqs:DeleteMessage. The starter does not mount host AWS credentials into containers automatically.

Nginx proxies admin API, public/signup/tracking, and unsubscribe routes to the API. Caddyfile.example shows an outer HTTPS proxy to Nginx. Express trusts loopback/private reverse proxies for client IP calculation; keep the API bound behind your trusted proxies as Compose does. Provide backups, appropriate database credentials, logs and TLS for deployment.

The authentication model now supports owner/editor/analyst accounts, HTTP-only cookie sessions, CSRF-protected writes, and a bootstrap administrator key. Scoped transactional keys remain separate. SMTP relay and a complete migration of all Mautic entities/history remain outside this implementation; mapped contact CSV migration, tags, scores, JSON fields, and opt-outs are included. No deployment or external provider provisioning occurred.

## Accounts and access

After migrations, create the first owner through the Team page while signed in with the bootstrap workspace key, or run `npm run owner:create` locally. The command prompts for email/name, generates a temporary password, and shows it once. It does not accept a password in command-line arguments. `npm run owner:reset` is deliberate server-local recovery; it revokes prior sessions and requires a password change. These scripts are also copied into the API image for later operator use.

Accounts use Node scrypt hashes, seven-day HTTP-only SameSite=Strict sessions, and secure cookies when PUBLIC_API_URL uses HTTPS. Login attempts are limited per IP and email. Temporary passwords must be replaced before other workspace routes become accessible. Owners manage accounts, sending settings, API keys and audit history; editors manage content/audiences/operations; analysts have read-only access plus their own password/session management. All route permissions are enforced server-side. At least one active owner must remain. Disabled users and password resets lose existing sessions.

Authentication endpoints: GET `/api/auth/session`, POST `/api/auth/login` with email/password, POST `/api/auth/logout`. The session response provides X-Dispatch-CSRF for subsequent cookie-authenticated mutations. The browser uses the same-origin reverse proxy. Root keys stay available for initial setup/recovery; they have owner privileges.

New admin routes: account/password, account/sessions, account/sessions/revoke-others, users, users/:id/reset-password, audit, operations, operations/:id/resolve, archived-contacts, archived-contacts/:id/restore, and contacts-export. Audit records contain actors, methods, paths and timestamps; they exclude request bodies and secrets. Audit persistence is best-effort after successful actions, with an explicit server warning on failure.

## Recovery and import details

Delivery operations can retry a failed message only when no provider request was recorded. Every manual retry advances a delivery generation, preventing stale BullMQ jobs from overwriting it. Unknown outcomes cannot be reset for sending; reconcile them against SES and record a verified provider ID or close the message without resending. Sending rows must remain claimed at least 15 minutes before being marked unknown. Notes are required. A recorded manual sent outcome uses the resolution timestamp if no sent timestamp is available.

Workflow email steps wait for sent/dry-run outcomes before advancing; delays therefore begin after the delivery step completes. Unknown/failed deliveries stop the enrollment for review. Retry the enrollment after resolving its waiting message. Stopping an enrollment suppresses a pending queued message, while in-flight mail cannot be recalled. Completed and cancelled enrollments cannot be retried through the recovery action.

CSV import can inspect/map nonstandard headers, including common Mautic export aliases. Tags accept semicolon/comma/pipe separators; score columns are mapped separately; custom_fields_json supports exported flat custom fields. Duplicate emails in a file are skipped after the first valid row. Imported unsubscribe/do-not-contact flags create opt-outs, while existing opt-outs are never reactivated by import. Archive restoration and automation enrollment are explicit switches, both off by default. A preview is not a lock: commit rechecks archive/list state. Contact exports include statuses, tags, scores and JSON fields, up to 100,000 rows per export; spreadsheet-formula protection can prefix dangerous cell values with an apostrophe.

Reports use the configured workspace timezone for daily buckets. Segments can match days since last open/click/delivery; no recorded event is treated as older than normal engagement windows. Segment rules are copied to a campaign when it is queued/scheduled, so later segment edits cannot silently broaden its audience.


## CMDA connector addition

See `../CMDA-CONNECTOR.md` for current sync/feedback behavior, consent rules, environment mapping and unexecuted rollout checks. The Dispatch connection UI and backend are wired; source verification and environment setup remain outstanding. Apply all pending migrations through 005 before starting this revision.
