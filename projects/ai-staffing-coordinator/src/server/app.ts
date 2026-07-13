import formbody from "@fastify/formbody";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import { access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sql, type Kysely } from "kysely";
import { ZodError } from "zod";
import { config as defaultConfig, type AppConfig } from "./config.js";
import { createDatabase } from "./db/database.js";
import type { Database } from "./db/types.js";
import { installAuthentication } from "./plugins/authentication.js";
import { assignmentRoutes } from "./routes/assignments.js";
import { authRoutes } from "./routes/auth.js";
import { callRoutes } from "./routes/calls.js";
import { dashboardRoutes } from "./routes/dashboard.js";
import { shiftRoutes, clientRoutes, locationRoutes } from "./routes/shifts.js";
import { simulatorRoutes } from "./routes/simulator.js";
import { webhookRoutes } from "./routes/webhooks.js";
import { workerRoutes } from "./routes/workers.js";

export interface BuildAppOptions {
  config?: AppConfig;
  db?: Kysely<Database>;
  logger?: boolean;
  staticRoot?: string;
}

async function fileExists(file: string): Promise<boolean> {
  return access(file).then(() => true, () => false);
}

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const appConfig = options.config ?? defaultConfig;
  const ownsDatabase = !options.db;
  const db = options.db ?? createDatabase(appConfig);
  const app = Fastify({
    trustProxy: true,
    bodyLimit: 1_048_576,
    logger: options.logger === false
      ? false
      : {
          level: appConfig.LOG_LEVEL,
          redact: {
            paths: [
              "req.headers.authorization",
              "req.headers.cookie",
              "request.headers.authorization",
              "request.headers.cookie",
              "TWILIO_AUTH_TOKEN",
              "OPENAI_API_KEY",
            ],
            censor: "[redacted]",
          },
        },
  });

  app.decorate("config", appConfig);
  app.decorate("db", db);

  await app.register(formbody);
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:"],
        connectSrc: ["'self'"],
      },
    },
  });
  await app.register(rateLimit, { global: true, max: 300, timeWindow: "1 minute" });
  await installAuthentication(app);

  app.get("/health/live", async () => ({ status: "ok", service: "staffing-voice-agent" }));
  app.get("/health/ready", async (_request, reply) => {
    try {
      await sql`select 1`.execute(db);
      return { status: "ready", database: "ok" };
    } catch {
      return reply.code(503).send({ status: "not_ready", database: "unavailable" });
    }
  });

  await app.register(authRoutes, { prefix: "/api" });
  await app.register(workerRoutes, { prefix: "/api" });
  await app.register(clientRoutes, { prefix: "/api" });
  await app.register(locationRoutes, { prefix: "/api" });
  await app.register(shiftRoutes, { prefix: "/api" });
  await app.register(assignmentRoutes, { prefix: "/api" });
  await app.register(dashboardRoutes, { prefix: "/api" });
  await app.register(callRoutes);
  await app.register(simulatorRoutes);
  await app.register(webhookRoutes);

  const clientRoot = options.staticRoot ?? fileURLToPath(new URL("../client", import.meta.url));
  if (await fileExists(path.join(clientRoot, "index.html"))) {
    await app.register(fastifyStatic, { root: clientRoot, prefix: "/" });
    app.setNotFoundHandler((request, reply) => {
      if (request.method === "GET" && request.headers.accept?.includes("text/html")) {
        return reply.sendFile("index.html");
      }
      return reply.code(404).send({ error: "not_found", message: "Route not found" });
    });
  }

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({
        error: "validation_error",
        message: "The request was invalid",
        details: error.flatten(),
        requestId: request.id,
      });
    }
    const candidateStatus = typeof error === "object" && error !== null && "statusCode" in error
      ? (error as { statusCode?: unknown }).statusCode
      : undefined;
    const statusCode = typeof candidateStatus === "number" && candidateStatus >= 400 && candidateStatus < 500
      ? candidateStatus
      : 500;
    if (statusCode >= 500) request.log.error({ err: error }, "Request failed");
    return reply.code(statusCode).send({
      error: statusCode === 500 ? "internal_error" : "request_error",
      message: statusCode === 500
        ? "The service could not complete the request"
        : error instanceof Error ? error.message : "The request could not be completed",
      requestId: request.id,
    });
  });

  if (ownsDatabase) app.addHook("onClose", async () => db.destroy());
  return app;
}
