import "server-only";

import { z } from "zod";
import { db } from "@/server/db";

const statusTransitions: Record<string, readonly string[]> = {
  OPEN: ["PENDING", "RESOLVED", "CLOSED"],
  PENDING: ["OPEN", "RESOLVED", "CLOSED"],
  RESOLVED: ["OPEN", "CLOSED"],
  CLOSED: ["OPEN"],
};

const updateSchema = z.object({
  tenantId: z.string().trim().min(1).max(191),
  ticketId: z.string().trim().min(1).max(191),
  actorId: z.string().trim().min(1).max(191),
  status: z.enum(["OPEN", "PENDING", "RESOLVED", "CLOSED"]),
  reason: z.string().trim().min(5).max(500),
});

export async function updateSupportTicketStatus(rawInput: unknown) {
  const input = updateSchema.parse(rawInput);
  return db.$transaction(async (tx) => {
    const actor = await tx.user.findFirst({
      where: {
        id: input.actorId,
        tenantId: input.tenantId,
        status: "ACTIVE",
        role: { in: ["ADMIN", "OPERATIONS", "SUPPORT"] },
      },
      select: { id: true },
    });
    if (!actor) throw new Error("Operator is not authorized to manage support tickets");
    const ticket = await tx.supportTicket.findFirst({
      where: { id: input.ticketId, tenantId: input.tenantId },
    });
    if (!ticket) throw new Error("Support ticket not found");
    if (ticket.status === input.status) return { ticket, idempotent: true };
    if (!statusTransitions[ticket.status]?.includes(input.status)) {
      throw new Error(`Support ticket cannot transition from ${ticket.status} to ${input.status}`);
    }
    const changed = await tx.supportTicket.updateMany({
      where: { id: ticket.id, tenantId: input.tenantId, status: ticket.status },
      data: { status: input.status },
    });
    if (changed.count !== 1) throw new Error("Support ticket changed while the decision was recorded; retry");
    await tx.auditEvent.create({
      data: {
        tenantId: input.tenantId,
        actorType: "ADMIN",
        actorId: actor.id,
        action: "SUPPORT_TICKET_STATUS_CHANGED",
        resourceType: "SupportTicket",
        resourceId: ticket.id,
        reason: input.reason,
        metadataJson: JSON.stringify({ from: ticket.status, to: input.status }),
      },
    });
    return {
      ticket: await tx.supportTicket.findUniqueOrThrow({ where: { id: ticket.id } }),
      idempotent: false,
    };
  });
}
