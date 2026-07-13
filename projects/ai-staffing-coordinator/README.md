# Relay Staffing Voice Agent

Relay is a deployable staffing operations system that tracks workers and shifts, calls eligible workers with an AI scheduling assistant, safely accepts or declines shift offers, and sends consent-aware SMS reminders. It includes a responsive operator dashboard and a complete mock communications mode for local end-to-end testing without placing a paid phone call.

## What works

- Tenant-scoped worker profiles: contact details, roles, skills, certifications, availability, timezone, status, notes, and separate voice/SMS consent evidence.
- Clients, locations, shifts, headcount, pay rate, required skills, and assignment lifecycle.
- Transactional shift acceptance with capacity and overlapping-shift protection.
- Automatic eligible-worker ranking and durable outbound call jobs.
- Twilio outbound voice, speech/DTMF `<Gather>`, signed status/turn webhooks, and inbound SMS opt-out synchronization.
- OpenAI Responses API dialogue with strict scheduling tools; the model cannot write directly to staffing records.
- Durable, idempotent SMS reminders with retries, delivery callbacks, sender identification, and STOP language.
- Call sessions, text turns, messages, job state, and business audit logs.
- JWT-protected operator dashboard, role-aware API, health checks, Docker image, and Railway configuration.
- Local simulator for accept, decline, callback, unclear responses, calls, and reminders.

## Run locally

Prerequisites: Node.js 22+ and Docker.

```bash
cp .env.example .env
docker compose up -d postgres
npm install
npm run db:migrate
npm run db:seed
npm run dev
```

Open <http://localhost:5173> and sign in with the `ADMIN_EMAIL` and `ADMIN_PASSWORD` from `.env` (the defaults are `admin@example.com` / `ChangeMe123!`). Change those values before using any non-local environment. To run a passwordless portfolio demo instead, set `PUBLIC_DEMO_MODE=true`; the server will pin every protected request to the bootstrap demo organization and will refuse to start unless `COMMUNICATION_PROVIDER=mock`.

For a zero-setup, in-memory demonstration (no Docker or PostgreSQL installation), run:

```bash
npm install
npm run demo
```

Open <http://127.0.0.1:3100>. No sign-in is required in this mode. It uses embedded PostgreSQL-compatible PGlite, mock calls/texts, fictional data, and resets when stopped. Production always uses PostgreSQL.

The seed creates a fictional hotel shift and four fictional consented workers using non-routable example phone numbers. `COMMUNICATION_PROVIDER=mock` records calls and messages in the simulator instead of contacting anyone.

### Public portfolio deployment

Use the following safety pairing for a publicly accessible, interactive portfolio demo:

```dotenv
NODE_ENV=production
PUBLIC_BASE_URL=https://staffing.example.com
PUBLIC_DEMO_MODE=true
COMMUNICATION_PROVIDER=mock
```

Public demo mode removes the login screen and supplies a fixed scheduler identity for the bootstrap organization (`org_default`). On startup it idempotently restores fictional clients, workers, and a future demo shift; the production-safe Demo lab is enabled and resets each selected shift scenario so it can be run repeatedly. Reads and fictional mutations remain tenant-scoped, password login is disabled, logout is a no-op, and Twilio cannot be selected or initialized. Do not put real worker or client information in the public demo database. For a real staffing-company deployment with live communications, use `PUBLIC_DEMO_MODE=false`, normal operator authentication, and complete the compliance launch gate.

To exercise the production build locally:

```bash
npm run build
npm start
```

The built dashboard and API are then available at <http://localhost:3000>.

## Verification

```bash
npm run check
```

This runs both TypeScript projects, unit/integration tests, and a production client/server build. With PostgreSQL running and demo data seeded, the authenticated smoke test can also be run with:

```bash
npm run smoke
```

## Enable real calls and texts

Use a Twilio subaccount or dedicated project for initial testing. Configure:

```dotenv
NODE_ENV=production
PUBLIC_BASE_URL=https://staffing.example.com
COMMUNICATION_PROVIDER=twilio
PUBLIC_DEMO_MODE=false
TWILIO_ACCOUNT_SID=...
TWILIO_AUTH_TOKEN=...
TWILIO_PHONE_NUMBER=+1...
TWILIO_MESSAGING_SERVICE_SID=MG...
TWILIO_VALIDATE_WEBHOOKS=true
OPENAI_API_KEY=...
OPENAI_MODEL=gpt-5.6-luna
```

The application creates outbound calls through Twilio itself. Point the Messaging Service's inbound message webhook at:

```text
POST https://staffing.example.com/webhooks/twilio/sms
```

Use the app's HTTPS public URL exactly as configured in `PUBLIC_BASE_URL`; Twilio signature validation includes the URL. Do not put a development tunnel URL into production.

Before enabling the provider, read [Communications, privacy, and launch controls](docs/COMPLIANCE_AND_SAFETY.md). Twilio requires prior consent for application-to-person messaging, proof of consent, sender identification, and accessible opt-out. Your company remains responsible for the laws and carrier rules that apply to its workers and jurisdictions.

## Deploy on Railway

The repository has a multi-stage `Dockerfile` and `railway.json` health check. Create one Railway project with:

1. a PostgreSQL service;
2. an application service sourced from this repository;
3. the environment variables above, using Railway's `DATABASE_URL` reference from PostgreSQL;
4. a generated public domain, copied into `PUBLIC_BASE_URL`;
5. at least 32 random bytes for `JWT_SECRET` and a unique `ADMIN_PASSWORD`.

Deploy from this directory with the Railway CLI:

```bash
railway up --detach -m "Deploy staffing voice agent"
```

A queued build is not a successful deployment. Verify the newest deployment reaches `SUCCESS`, then check `/health/ready`, sign in, create a test worker with explicit consent, and complete the launch checklist before real traffic.

## Important environment variables

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string |
| `JWT_SECRET` | Signs operator sessions; must be unique and secret |
| `PUBLIC_BASE_URL` | HTTPS origin used to construct and validate provider webhooks |
| `PUBLIC_DEMO_MODE` | Enables the passwordless, bootstrap-tenant portfolio demo; requires the mock provider |
| `COMMUNICATION_PROVIDER` | `mock` or `twilio` |
| `OPENAI_API_KEY` / `OPENAI_MODEL` | Voice conversation model access and configurable model |
| `TWILIO_*` | Voice/Messaging credentials, sender, and validation switch |
| `REMINDER_OFFSETS_MINUTES` | Comma-separated offsets such as `1440,120` |
| `CONTACT_WINDOW_START_LOCAL` / `END` | Worker-local outbound contact window |
| `SCHEDULER_ENABLED` | Pauses or enables durable background communications |
| `TRANSCRIPT_RETENTION_DAYS` | Company-approved minimal text transcript retention target |

See [.env.example](.env.example) for the full list.

## Operational documentation

- [Architecture and safety model](docs/ARCHITECTURE.md)
- [Compliance and launch checklist](docs/COMPLIANCE_AND_SAFETY.md)
- [Production runbook](docs/PRODUCTION_RUNBOOK.md)

## Deliberate boundaries

Relay schedules shifts; it is not a payroll, timeclock, I-9, medical, background-check, or HR document system. Do not place highly sensitive HR data in notes, prompts, transcripts, or text messages. The default application does not record audio. A live launch requires company-specific legal, privacy, security, sender-registration, and operational review.
