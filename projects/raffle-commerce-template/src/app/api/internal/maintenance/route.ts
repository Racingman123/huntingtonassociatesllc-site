import { createHash, timingSafeEqual } from "node:crypto";
import { runMaintenance } from "@/server/maintenance/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function authorized(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || secret.length < 32) return false;
  const supplied = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  const expectedHash = createHash("sha256").update(secret).digest();
  const suppliedHash = createHash("sha256").update(supplied).digest();
  return timingSafeEqual(expectedHash, suppliedHash);
}

function json(body: Record<string, unknown>, status: number) {
  return Response.json(body, {
    status,
    headers: {
      "Cache-Control": "private, no-store, max-age=0",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export async function POST(request: Request) {
  if (!authorized(request)) return json({ error: "Unauthorized" }, 401);
  try {
    const result = await runMaintenance();
    const deliveryFailures = result.emailDelivery.retried + result.emailDelivery.deadLettered;
    const hasFailures = result.campaignActivation.failures > 0
      || result.cancellationFailures > 0
      || result.stripeCheckoutCleanup.failures > 0
      || deliveryFailures > 0;
    return json({ ok: !hasFailures, ...result }, hasFailures ? 207 : 200);
  } catch {
    return json({ ok: false, error: "Maintenance pass failed" }, 500);
  }
}
