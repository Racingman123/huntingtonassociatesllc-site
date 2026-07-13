import bcrypt from "bcryptjs";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { SESSION_COOKIE } from "../plugins/authentication.js";
import { writeAuditLog } from "../services/audit.js";

const loginSchema = z.object({
  email: z.string().trim().email(),
  password: z.string().min(1),
  organizationId: z.string().trim().min(1).optional(),
});

export const authRoutes: FastifyPluginAsync = async (app) => {
  app.post("/auth/login", {
    config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
  }, async (request, reply) => {
    if (app.config.PUBLIC_DEMO_MODE) {
      return reply.code(403).send({
        error: "public_demo_mode",
        message: "Password login is disabled for this public demo",
      });
    }
    const parsed = loginSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "validation_error", message: "Invalid login details", details: parsed.error.flatten() });

    let query = app.db.selectFrom("users").selectAll().where("email", "=", parsed.data.email.toLowerCase()).where("active", "=", true);
    if (parsed.data.organizationId) query = query.where("organizationId", "=", parsed.data.organizationId);
    const users = await query.limit(2).execute();
    const user = users.length === 1 ? users[0] : undefined;
    const valid = user ? await bcrypt.compare(parsed.data.password, user.passwordHash) : await bcrypt.compare(parsed.data.password, "$2b$12$7V6N.Q0v/e3hvxshc/TLcu8.mE3FKbuZQ6wFpv8bb7zQGl6Ng8Vl6");
    if (!user || !valid) return reply.code(401).send({ error: "invalid_credentials", message: "Email or password is incorrect" });

    const token = await reply.jwtSign({
      sub: user.id,
      organizationId: user.organizationId,
      email: user.email,
      name: user.name,
      role: user.role,
    });
    reply.setCookie(SESSION_COOKIE, token, {
      path: "/",
      httpOnly: true,
      sameSite: "lax",
      secure: app.config.NODE_ENV === "production",
      maxAge: 12 * 60 * 60,
    });
    await writeAuditLog(app.db, {
      organizationId: user.organizationId,
      actorType: "user",
      actorId: user.id,
      actorLabel: user.name,
      action: "auth.login",
      entityType: "user",
      entityId: user.id,
      ipAddress: request.ip,
    });
    return {
      token,
      user: {
        id: user.id,
        organizationId: user.organizationId,
        email: user.email,
        name: user.name,
        role: user.role,
        publicDemo: false,
      },
    };
  });

  app.post("/auth/logout", { preHandler: app.authenticate }, async (request, reply) => {
    if (app.config.PUBLIC_DEMO_MODE) return reply.code(204).send();
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    await writeAuditLog(app.db, {
      organizationId: request.user.organizationId,
      actorType: "user",
      actorId: request.user.sub,
      actorLabel: request.user.name,
      action: "auth.logout",
      entityType: "user",
      entityId: request.user.sub,
      ipAddress: request.ip,
    });
    return reply.code(204).send();
  });

  app.get("/auth/me", { preHandler: app.authenticate }, async (request) => ({
    user: {
      id: request.user.sub,
      organizationId: request.user.organizationId,
      email: request.user.email,
      name: request.user.name,
      role: request.user.role,
      publicDemo: app.config.PUBLIC_DEMO_MODE,
    },
  }));
};
