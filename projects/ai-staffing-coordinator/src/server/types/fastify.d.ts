import type { FastifyReply, FastifyRequest } from "fastify";
import type { Kysely } from "kysely";
import type { AppConfig } from "../config.js";
import type { Database } from "../db/types.js";

export interface AuthTokenPayload {
  sub: string;
  organizationId: string;
  email: string;
  name: string;
  role: "admin" | "scheduler" | "viewer";
  publicDemo?: boolean;
}

declare module "fastify" {
  interface FastifyInstance {
    db: Kysely<Database>;
    config: AppConfig;
    authenticate(request: FastifyRequest, reply: FastifyReply): Promise<void>;
  }
}

declare module "@fastify/jwt" {
  interface FastifyJWT {
    payload: AuthTokenPayload;
    user: AuthTokenPayload;
  }
}
