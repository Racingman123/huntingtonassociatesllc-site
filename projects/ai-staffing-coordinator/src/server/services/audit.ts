import type { FastifyRequest } from "fastify";
import type { Kysely, Transaction } from "kysely";
import { nanoid } from "nanoid";
import type { Database } from "../db/types.js";

export interface AuditEvent {
  organizationId: string;
  actorType: "user" | "worker" | "system" | "provider";
  actorId?: string | null;
  actorLabel: string;
  action: string;
  entityType: string;
  entityId?: string | null;
  metadata?: Record<string, unknown>;
  ipAddress?: string | null;
}

export async function writeAuditLog(db: Kysely<Database> | Transaction<Database>, event: AuditEvent): Promise<void> {
  await db.insertInto("auditLogs").values({
    id: nanoid(),
    organizationId: event.organizationId,
    actorType: event.actorType,
    actorId: event.actorId ?? null,
    actorLabel: event.actorLabel,
    action: event.action,
    entityType: event.entityType,
    entityId: event.entityId ?? null,
    metadata: event.metadata ?? {},
    ipAddress: event.ipAddress ?? null,
  }).execute();
}

export function userAuditContext(request: FastifyRequest): Pick<AuditEvent, "organizationId" | "actorType" | "actorId" | "actorLabel" | "ipAddress"> {
  return {
    organizationId: request.user.organizationId,
    actorType: "user",
    actorId: request.user.sub,
    actorLabel: request.user.name,
    ipAddress: request.ip,
  };
}
