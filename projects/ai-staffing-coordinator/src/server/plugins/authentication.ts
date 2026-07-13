import cookie from "@fastify/cookie";
import jwt from "@fastify/jwt";
import type { FastifyInstance } from "fastify";
import { BOOTSTRAP_ORGANIZATION_ID } from "../db/bootstrap.js";

export const SESSION_COOKIE = "staffing_session";
export const PUBLIC_DEMO_USER = {
  sub: "public-demo",
  organizationId: BOOTSTRAP_ORGANIZATION_ID,
  email: "demo@relay.example",
  name: "Portfolio Demo",
  role: "scheduler" as const,
  publicDemo: true,
};

/** Install this directly on the root Fastify instance before registering routes. */
export async function installAuthentication(app: FastifyInstance): Promise<void> {
  await app.register(cookie);
  await app.register(jwt, {
    secret: app.config.JWT_SECRET,
    cookie: { cookieName: SESSION_COOKIE, signed: false },
    sign: { expiresIn: "12h" },
  });

  app.decorate("authenticate", async function authenticate(request, reply): Promise<void> {
    if (app.config.PUBLIC_DEMO_MODE) {
      // Never trust a caller-supplied token in public mode. Every protected route
      // receives the same fixed tenant boundary and can only mutate demo records.
      request.user = { ...PUBLIC_DEMO_USER };
      return;
    }
    try {
      await request.jwtVerify();
      const user = await app.db
        .selectFrom("users")
        .select(["id", "organizationId", "active", "role", "email", "name"])
        .where("id", "=", request.user.sub)
        .where("organizationId", "=", request.user.organizationId)
        .executeTakeFirst();
      if (!user?.active) {
        reply.code(401).send({ error: "unauthorized", message: "Your session is no longer active" });
        return;
      }
      // Refresh mutable identity fields while preserving the verified tenant boundary.
      request.user.email = user.email;
      request.user.name = user.name;
      request.user.role = user.role;
    } catch {
      reply.code(401).send({ error: "unauthorized", message: "A valid session or bearer token is required" });
    }
  });
}

export function canManageStaffing(role: "admin" | "scheduler" | "viewer"): boolean {
  return role === "admin" || role === "scheduler";
}
