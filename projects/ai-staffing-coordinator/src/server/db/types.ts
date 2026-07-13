import type { ColumnType, Generated, Insertable, Selectable, Updateable } from "kysely";

export type Timestamp = ColumnType<Date, Date | string, Date | string>;
export type JsonColumn<T> = ColumnType<T, T | string, T | string>;

interface TenantColumns {
  organizationId: string;
}

interface TimestampColumns {
  createdAt: Generated<Date>;
  updatedAt: Generated<Date>;
}

export interface OrganizationsTable extends TimestampColumns {
  id: string;
  name: string;
  timezone: string;
}

export interface UsersTable extends TenantColumns, TimestampColumns {
  id: string;
  email: string;
  passwordHash: string;
  name: string;
  role: "admin" | "scheduler" | "viewer";
  active: Generated<boolean>;
}

export interface WorkersTable extends TenantColumns, TimestampColumns {
  id: string;
  firstName: string;
  lastName: string;
  phone: string;
  email: string | null;
  status: "active" | "inactive" | "suspended";
  roles: JsonColumn<string[]>;
  skills: JsonColumn<string[]>;
  certifications: JsonColumn<Array<{ name: string; expiresAt?: string }>>;
  availability: JsonColumn<Record<string, Array<{ start: string; end: string }>>>;
  timezone: string;
  address: string | null;
  notes: string | null;
  voiceConsent: Generated<boolean>;
  voiceConsentAt: Timestamp | null;
  voiceConsentSource: string | null;
  smsConsent: Generated<boolean>;
  smsConsentAt: Timestamp | null;
  smsConsentSource: string | null;
  doNotCall: Generated<boolean>;
  doNotText: Generated<boolean>;
  lastContactedAt: Timestamp | null;
}

export interface ClientsTable extends TenantColumns, TimestampColumns {
  id: string;
  name: string;
  contactName: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  active: Generated<boolean>;
}

export interface LocationsTable extends TenantColumns, TimestampColumns {
  id: string;
  clientId: string;
  name: string;
  address: string;
  timezone: string;
  instructions: string | null;
}

export interface ShiftsTable extends TenantColumns, TimestampColumns {
  id: string;
  clientId: string;
  locationId: string;
  role: string;
  requiredSkills: JsonColumn<string[]>;
  startsAt: Timestamp;
  endsAt: Timestamp;
  headcount: number;
  payRateCents: number | null;
  status: "draft" | "open" | "filled" | "cancelled" | "completed";
  notes: string | null;
  autoFillEnabled: Generated<boolean>;
  autoFillStartedAt: Timestamp | null;
}

export interface AssignmentsTable extends TenantColumns, TimestampColumns {
  id: string;
  shiftId: string;
  workerId: string;
  status: "candidate" | "offered" | "accepted" | "declined" | "cancelled" | "completed" | "no_show";
  offeredAt: Timestamp | null;
  acceptedAt: Timestamp | null;
  declinedAt: Timestamp | null;
  declineReason: string | null;
  source: "manual" | "voice" | "sms" | "automation";
}

export interface CallSessionsTable extends TenantColumns, TimestampColumns {
  id: string;
  workerId: string;
  shiftId: string | null;
  assignmentId: string | null;
  providerCallId: string | null;
  status: "queued" | "initiated" | "ringing" | "in_progress" | "completed" | "busy" | "failed" | "no_answer" | "cancelled";
  direction: "outbound" | "inbound";
  attempt: Generated<number>;
  disclosurePlayedAt: Timestamp | null;
  startedAt: Timestamp | null;
  endedAt: Timestamp | null;
  outcome: string | null;
  errorMessage: string | null;
}

export interface ConversationTurnsTable extends TenantColumns {
  id: string;
  callSessionId: string;
  sequence: number;
  speaker: "agent" | "worker" | "system";
  text: string;
  toolName: string | null;
  toolPayload: JsonColumn<Record<string, unknown>> | null;
  createdAt: Generated<Date>;
}

export interface MessagesTable extends TenantColumns, TimestampColumns {
  id: string;
  workerId: string;
  assignmentId: string | null;
  providerMessageId: string | null;
  direction: "outbound" | "inbound";
  channel: "sms";
  body: string;
  status: "queued" | "sent" | "delivered" | "failed" | "received" | "suppressed";
  idempotencyKey: string | null;
  errorMessage: string | null;
  sentAt: Timestamp | null;
  deliveredAt: Timestamp | null;
}

export interface JobsTable extends TenantColumns, TimestampColumns {
  id: string;
  type: "shift_reminder" | "outbound_call" | "campaign_tick";
  status: "pending" | "processing" | "completed" | "failed" | "cancelled";
  runAt: Timestamp;
  payload: JsonColumn<Record<string, unknown>>;
  idempotencyKey: string;
  attempts: Generated<number>;
  maxAttempts: Generated<number>;
  lockedAt: Timestamp | null;
  lockedBy: string | null;
  lastError: string | null;
  completedAt: Timestamp | null;
}

export interface AuditLogsTable extends TenantColumns {
  id: string;
  actorType: "user" | "worker" | "system" | "provider";
  actorId: string | null;
  actorLabel: string;
  action: string;
  entityType: string;
  entityId: string | null;
  metadata: JsonColumn<Record<string, unknown>>;
  ipAddress: string | null;
  createdAt: Generated<Date>;
}

export interface Database {
  organizations: OrganizationsTable;
  users: UsersTable;
  workers: WorkersTable;
  clients: ClientsTable;
  locations: LocationsTable;
  shifts: ShiftsTable;
  assignments: AssignmentsTable;
  callSessions: CallSessionsTable;
  conversationTurns: ConversationTurnsTable;
  messages: MessagesTable;
  jobs: JobsTable;
  auditLogs: AuditLogsTable;
}

export type Worker = Selectable<WorkersTable>;
export type NewWorker = Insertable<WorkersTable>;
export type WorkerUpdate = Updateable<WorkersTable>;
export type Shift = Selectable<ShiftsTable>;
export type NewShift = Insertable<ShiftsTable>;
export type Assignment = Selectable<AssignmentsTable>;
export type Job = Selectable<JobsTable>;
