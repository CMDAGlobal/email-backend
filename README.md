# Dispatch backend

Dispatch is a self-hosted email platform built with NestJS, MongoDB, Amazon SES, and SQS. MongoDB is the only application database. Contacts, consent, lists, campaigns, templates, automations, signup forms, sessions, audit history, reports, CMDA links, the durable delivery queue, provider events, suppressions, and unsubscribe records all live in the Dispatch MongoDB database.

CMDA keeps its own member-management MongoDB cluster. Dispatch does not connect to that database directly: CMDA sends signed member snapshots to the bridge and Dispatch returns signed consent/delivery feedback.

## Environments

Copy `.env.example` to `.env` with `npm run setup`. The minimum local services are:

- MongoDB replica set: required because consent and bridge changes use transactions.
- API: NestJS HTTP service.
- Worker: prepares campaign audiences, claims messages, sends through SES (or dry-run), reads SQS events, and delivers CMDA feedback.
- Frontend: the sibling `../frontend` React application.

Local Docker stack:

```sh
npm ci
npm run setup
docker compose up --build
```

Open `http://localhost:8080`. The Compose stack creates a single-node MongoDB replica set, initializes indexes/default records, then starts the API and worker. `SEND_MODE=dry-run` records messages without contacting SES.

For development without the full stack, start a MongoDB replica set, then run `npm run migrate`, `npm run dev`, `npm run dev:worker`, and `npm run dev` in `../frontend`.

## MongoDB layout

Use one database owned by Dispatch, configured with both `MONGODB_URI` and `MONGODB_DATABASE`. API, worker, owner setup, and migration commands must use the same values. Production should use MongoDB Atlas or another backed-up replica set with TLS, authentication, least-privilege credentials, monitoring, and point-in-time recovery.

`npm run migrate` is idempotent: it creates required indexes and seed documents. There are no SQL migrations and no Redis service.

## Sending and consent

Campaign recipients are frozen into MongoDB `messages` documents when a campaign becomes due. The worker atomically changes each message from `queued` to `sending`, rechecks contact status, suppressions, campaign state, and current CMDA permission, then records `sent`, `dry_run`, `suppressed`, or `unknown`. SES timeouts become `unknown` because SES sends have no application idempotency key and must be reconciled rather than blindly retried.

Marketing mail requires a company, postal address, and `{{unsubscribe_url}}`. Signed unsubscribe POSTs update the contact, create a protected suppression, and enqueue signed `marketing.unsubscribed` feedback for CMDA. A later CMDA sync can restore consent only when it acknowledges that feedback sequence and includes a newer consent timestamp. Permanent bounces and complaints are also protected suppressions.

Public signup forms use double opt-in with hashed 24-hour tokens. Confirmation can clear an unsubscribe suppression, but never a bounce, complaint, or manual block.

## CMDA bridge

Configure `CMDA_ENABLED`, `CMDA_SYNC_SECRET`, `CMDA_FEEDBACK_SECRET`, and `CMDA_FEEDBACK_URL`. The two secrets must be different and at least 32 characters. Inbound requests are timestamped, signed, nonce-protected, revisioned, and idempotent. Dispatch stores only the member fields needed for targeting and consent enforcement.

The connector creates a managed CMDA audience and standard segments. Stale, deleted, inactive, opted-out, suppressed, or unverified-permission members are excluded at audience preparation and checked again immediately before delivery.

## Accounts and API

Create the first owner with `npm run owner:create`; `npm run owner:reset` deliberately replaces its password and revokes sessions. Passwords use scrypt. Browser sessions are HTTP-only, SameSite=Strict, and CSRF-protected. The bootstrap `API_KEY` remains available for recovery and initial setup.

The admin API is under `/api/v1/manage`, transactional sending is `POST /api/v1/send`, health is `/health`, and Swagger discovery is `/docs`. Transactional keys are stored as hashes and are separate from admin access.

## AWS

For live delivery, set `SEND_MODE=ses`, verify `SES_FROM_EMAIL`, configure DKIM/SPF/DMARC and an SES configuration set, and give the worker `ses:SendEmail`. Route SES delivery, bounce, and complaint events through SNS to SQS and set `SES_EVENTS_QUEUE_URL`; the worker needs `sqs:ReceiveMessage` and `sqs:DeleteMessage`. Prefer an IAM role rather than static credentials.

## Verification

```sh
npm run build
npm test
npm run test:http
npm run test:cmda
```

`test:cmda` requires `DISPATCH_E2E_MONGODB_URI` pointing to a disposable local MongoDB replica set. It creates and removes its own uniquely named database and validates opted-in delivery, exclusion without consent, signed unsubscribe feedback, stale-consent rejection, and explicit re-consent.
