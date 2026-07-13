import { db } from "@/server/db";
import { getDeploymentReadiness } from "@/server/readiness";

export async function GET() {
  try {
    await db.tenant.count();
    const configuration = getDeploymentReadiness();
    const status = configuration.ready ? 200 : 503;
    return Response.json({
      status: configuration.ready ? "ready" : "not_ready",
      database: "reachable",
      configuration: configuration.checks.map((check) => ({ key: check.key, status: check.status })),
      timestamp: new Date().toISOString(),
    }, {
      status,
      headers: { "Cache-Control": "no-store" },
    });
  } catch {
    return Response.json({ status: "not_ready", database: "unreachable" }, {
      status: 503,
      headers: { "Cache-Control": "no-store" },
    });
  }
}
