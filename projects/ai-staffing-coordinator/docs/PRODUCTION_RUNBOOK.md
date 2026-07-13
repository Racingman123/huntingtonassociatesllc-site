# Production runbook

## Health and process model

- `GET /health/live`: process liveness.
- `GET /health/ready`: database readiness.
- Web/API and background job polling run in the same image by default.
- Set `SCHEDULER_ENABLED=false` on web-only replicas when operating a dedicated worker process.

The Docker entrypoint runs database migrations before accepting traffic. Migrations use PostgreSQL's migration lock so two starting replicas do not apply the same migration concurrently.

## Public demo mode

A public portfolio deployment must set `PUBLIC_DEMO_MODE=true` and `COMMUNICATION_PROVIDER=mock`. Startup validation rejects any public-demo/Twilio combination, and the provider factory independently refuses to initialize a live provider in public demo mode. The dashboard has no login or logout flow and all protected requests are pinned to the bootstrap organization (`org_default`) as the fixed `Portfolio Demo` scheduler. Each startup idempotently restores the fixed fictional seed records and moves the seeded shift into the future. Simulator routes remain available in this production mode only, and each Demo lab run clears the selected shift's previous demo offers before recording the new outcome.

Treat the public database as disposable, fictional demonstration data. Never import real workers, phone numbers, client contacts, or shift details. Public visitors share the demo tenant and can exercise its simulated mutations. A real operational deployment must set `PUBLIC_DEMO_MODE=false`, retain operator authentication, and follow the live-provider controls below.

## Routine checks

At the start of each shift-management day:

- confirm readiness and database backup status;
- review failed jobs, failed calls, and message delivery errors;
- review open shifts that are still below headcount;
- review workers who requested callbacks;
- verify the expected Twilio number is active and OpenAI/Twilio account limits are healthy.

## Incident controls

### Stop all outbound automation

Set `SCHEDULER_ENABLED=false` and redeploy/restart. This stops jobs from being claimed without deleting their audit trail. Existing provider calls already sent cannot be recalled reliably; use the Twilio console for emergency termination.

### Stop one channel for one worker

Set `doNotCall` or `doNotText` on the worker profile. The flag is rechecked at job execution time.

### Bad or unsafe model response

Disable the affected shift's auto-fill, preserve the call session ID, export the text turns and audit entries, and reproduce it in mock mode. A model response alone does not modify a record; inspect the corresponding validated tool audit event.

### Duplicate acceptance report

Query assignments by shift and worker, then inspect audit events. Capacity and overlap validation is transactional; do not manually delete records before determining whether the duplicate is a display issue, a repeated provider webhook, or distinct shifts.

### Provider outage

Leave jobs pending, increase neither retry rate nor call concurrency during the outage, and communicate through the approved manual channel. Once stable, resume with a small batch and monitor delivery status.

## Backup and recovery

Use managed PostgreSQL point-in-time recovery in production. Retain daily logical backups outside the primary project. Quarterly, restore the newest backup into an isolated environment and verify organizations, workers, future shifts, assignments, jobs, and audit records.

Recovery priorities:

1. database and application secrets;
2. future accepted assignments and worker contact preferences;
3. open shifts and queued reminders;
4. call/message history and analytics.

After a restore, keep the scheduler disabled until queued jobs are reviewed; otherwise old reminders may be sent.

## Key rotation

Rotate JWT, Twilio, OpenAI, and database credentials on a documented schedule and immediately after suspected exposure. JWT rotation invalidates active dashboard sessions. When rotating Twilio credentials, update the application and verify webhook signature checks before resuming calls.
