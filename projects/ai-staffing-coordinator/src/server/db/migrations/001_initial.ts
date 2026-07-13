import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table organizations (
      id text primary key,
      name text not null,
      timezone text not null default 'America/New_York',
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    )
  `.execute(db);

  await sql`
    create table users (
      id text primary key,
      organization_id text not null references organizations(id) on delete cascade,
      email text not null,
      password_hash text not null,
      name text not null,
      role text not null check (role in ('admin', 'scheduler', 'viewer')),
      active boolean not null default true,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      unique (organization_id, email)
    )
  `.execute(db);

  await sql`
    create table workers (
      id text primary key,
      organization_id text not null references organizations(id) on delete cascade,
      first_name text not null,
      last_name text not null,
      phone text not null,
      email text,
      status text not null default 'active' check (status in ('active', 'inactive', 'suspended')),
      roles jsonb not null default '[]'::jsonb check (jsonb_typeof(roles) = 'array'),
      skills jsonb not null default '[]'::jsonb check (jsonb_typeof(skills) = 'array'),
      certifications jsonb not null default '[]'::jsonb check (jsonb_typeof(certifications) = 'array'),
      availability jsonb not null default '{}'::jsonb check (jsonb_typeof(availability) = 'object'),
      timezone text not null default 'America/New_York',
      address text,
      notes text,
      voice_consent boolean not null default false,
      voice_consent_at timestamptz,
      voice_consent_source text,
      sms_consent boolean not null default false,
      sms_consent_at timestamptz,
      sms_consent_source text,
      do_not_call boolean not null default false,
      do_not_text boolean not null default false,
      last_contacted_at timestamptz,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      unique (organization_id, phone)
    )
  `.execute(db);
  await sql`create unique index workers_org_email_unique on workers (organization_id, email) where email is not null`.execute(db);

  await sql`
    create table clients (
      id text primary key,
      organization_id text not null references organizations(id) on delete cascade,
      name text not null,
      contact_name text,
      contact_email text,
      contact_phone text,
      active boolean not null default true,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      unique (organization_id, name)
    )
  `.execute(db);

  await sql`
    create table locations (
      id text primary key,
      organization_id text not null references organizations(id) on delete cascade,
      client_id text not null references clients(id) on delete restrict,
      name text not null,
      address text not null,
      timezone text not null,
      instructions text,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      unique (organization_id, client_id, name)
    )
  `.execute(db);

  await sql`
    create table shifts (
      id text primary key,
      organization_id text not null references organizations(id) on delete cascade,
      client_id text not null references clients(id) on delete restrict,
      location_id text not null references locations(id) on delete restrict,
      role text not null,
      required_skills jsonb not null default '[]'::jsonb check (jsonb_typeof(required_skills) = 'array'),
      starts_at timestamptz not null,
      ends_at timestamptz not null,
      headcount integer not null check (headcount > 0),
      pay_rate_cents integer check (pay_rate_cents is null or pay_rate_cents >= 0),
      status text not null default 'draft' check (status in ('draft', 'open', 'filled', 'cancelled', 'completed')),
      notes text,
      auto_fill_enabled boolean not null default false,
      auto_fill_started_at timestamptz,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      check (ends_at > starts_at)
    )
  `.execute(db);

  await sql`
    create table assignments (
      id text primary key,
      organization_id text not null references organizations(id) on delete cascade,
      shift_id text not null references shifts(id) on delete cascade,
      worker_id text not null references workers(id) on delete restrict,
      status text not null default 'candidate' check (status in ('candidate', 'offered', 'accepted', 'declined', 'cancelled', 'completed', 'no_show')),
      offered_at timestamptz,
      accepted_at timestamptz,
      declined_at timestamptz,
      decline_reason text,
      source text not null default 'manual' check (source in ('manual', 'voice', 'sms', 'automation')),
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      unique (organization_id, shift_id, worker_id)
    )
  `.execute(db);

  await sql`
    create table call_sessions (
      id text primary key,
      organization_id text not null references organizations(id) on delete cascade,
      worker_id text not null references workers(id) on delete restrict,
      shift_id text references shifts(id) on delete set null,
      assignment_id text references assignments(id) on delete set null,
      provider_call_id text,
      status text not null default 'queued' check (status in ('queued', 'initiated', 'ringing', 'in_progress', 'completed', 'busy', 'failed', 'no_answer', 'cancelled')),
      direction text not null default 'outbound' check (direction in ('outbound', 'inbound')),
      attempt integer not null default 0 check (attempt >= 0),
      disclosure_played_at timestamptz,
      started_at timestamptz,
      ended_at timestamptz,
      outcome text,
      error_message text,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    )
  `.execute(db);
  await sql`create unique index call_sessions_provider_unique on call_sessions (provider_call_id) where provider_call_id is not null`.execute(db);

  await sql`
    create table conversation_turns (
      id text primary key,
      organization_id text not null references organizations(id) on delete cascade,
      call_session_id text not null references call_sessions(id) on delete cascade,
      sequence integer not null check (sequence >= 0),
      speaker text not null check (speaker in ('agent', 'worker', 'system')),
      text text not null,
      tool_name text,
      tool_payload jsonb,
      created_at timestamptz not null default now(),
      unique (call_session_id, sequence)
    )
  `.execute(db);

  await sql`
    create table messages (
      id text primary key,
      organization_id text not null references organizations(id) on delete cascade,
      worker_id text not null references workers(id) on delete restrict,
      assignment_id text references assignments(id) on delete set null,
      provider_message_id text,
      direction text not null check (direction in ('outbound', 'inbound')),
      channel text not null default 'sms' check (channel = 'sms'),
      body text not null,
      status text not null default 'queued' check (status in ('queued', 'sent', 'delivered', 'failed', 'received', 'suppressed')),
      idempotency_key text,
      error_message text,
      sent_at timestamptz,
      delivered_at timestamptz,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    )
  `.execute(db);
  await sql`create unique index messages_org_idempotency_unique on messages (organization_id, idempotency_key) where idempotency_key is not null`.execute(db);
  await sql`create unique index messages_provider_unique on messages (provider_message_id) where provider_message_id is not null`.execute(db);

  await sql`
    create table jobs (
      id text primary key,
      organization_id text not null references organizations(id) on delete cascade,
      type text not null check (type in ('shift_reminder', 'outbound_call', 'campaign_tick')),
      status text not null default 'pending' check (status in ('pending', 'processing', 'completed', 'failed', 'cancelled')),
      run_at timestamptz not null,
      payload jsonb not null default '{}'::jsonb,
      idempotency_key text not null,
      attempts integer not null default 0 check (attempts >= 0),
      max_attempts integer not null default 5 check (max_attempts > 0),
      locked_at timestamptz,
      locked_by text,
      last_error text,
      completed_at timestamptz,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      unique (organization_id, idempotency_key)
    )
  `.execute(db);

  await sql`
    create table audit_logs (
      id text primary key,
      organization_id text not null references organizations(id) on delete cascade,
      actor_type text not null check (actor_type in ('user', 'worker', 'system', 'provider')),
      actor_id text,
      actor_label text not null,
      action text not null,
      entity_type text not null,
      entity_id text,
      metadata jsonb not null default '{}'::jsonb,
      ip_address inet,
      created_at timestamptz not null default now()
    )
  `.execute(db);

  await sql`create index workers_org_status_idx on workers (organization_id, status)`.execute(db);
  await sql`create index shifts_org_start_status_idx on shifts (organization_id, starts_at, status)`.execute(db);
  await sql`create index assignments_org_worker_status_idx on assignments (organization_id, worker_id, status)`.execute(db);
  await sql`create index assignments_org_shift_status_idx on assignments (organization_id, shift_id, status)`.execute(db);
  await sql`create index call_sessions_org_created_idx on call_sessions (organization_id, created_at desc)`.execute(db);
  await sql`create index jobs_claim_idx on jobs (status, run_at) where status = 'pending'`.execute(db);
  await sql`create index audit_logs_org_created_idx on audit_logs (organization_id, created_at desc)`.execute(db);

  await sql`
    create function set_updated_at() returns trigger language plpgsql as $$
    begin
      new.updated_at = now();
      return new;
    end $$
  `.execute(db);
  for (const table of ["organizations", "users", "workers", "clients", "locations", "shifts", "assignments", "call_sessions", "messages", "jobs"]) {
    await sql.raw(`create trigger ${table}_set_updated_at before update on ${table} for each row execute function set_updated_at()`).execute(db);
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  for (const table of ["audit_logs", "jobs", "messages", "conversation_turns", "call_sessions", "assignments", "shifts", "locations", "clients", "workers", "users", "organizations"]) {
    await sql.raw(`drop table if exists ${table} cascade`).execute(db);
  }
  await sql`drop function if exists set_updated_at()`.execute(db);
}
