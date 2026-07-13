import type { FastifyReply, FastifyRequest } from "fastify";
import { canManageStaffing } from "./authentication.js";

export function requireManager(request: FastifyRequest, reply: FastifyReply): boolean {
  if (canManageStaffing(request.user.role)) return true;
  reply.code(403).send({ error: "forbidden", message: "Scheduler or administrator access is required" });
  return false;
}

export function isPgError(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code;
}

export function pageParams(query: unknown): { limit: number; offset: number } {
  const input = (query ?? {}) as Record<string, unknown>;
  const limit = Math.min(200, Math.max(1, Number(input.limit) || 50));
  const offset = Math.max(0, Number(input.offset) || 0);
  return { limit, offset };
}
