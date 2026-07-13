import { getStripeWebhookAdapter } from "@/server/providers/stripe/adapter";
import { asStripeBoundaryError, StripeBoundaryError } from "@/server/providers/stripe/errors";
import { STRIPE_WEBHOOK_MAX_BYTES } from "@/server/providers/stripe/signature";
import { readBoundedRequestBody, RequestBodyTooLargeError } from "@/server/http/bounded-body";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function json(body: Record<string, unknown>, status: number) {
  return Response.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export async function POST(request: Request) {
  // Demo mode is a complete boundary: it never accepts or settles live provider events.
  if (process.env.DEMO_MODE === "true") return json({ error: "Not found" }, 404);

  try {
    const declaredLength = Number(request.headers.get("content-length") ?? "0");
    if (Number.isFinite(declaredLength) && declaredLength > STRIPE_WEBHOOK_MAX_BYTES) {
      throw new StripeBoundaryError("PAYLOAD_TOO_LARGE", "Stripe webhook payload is too large", {
        httpStatus: 413,
      });
    }
    let rawBody: Uint8Array;
    try {
      rawBody = await readBoundedRequestBody(request, STRIPE_WEBHOOK_MAX_BYTES);
    } catch (error) {
      if (!(error instanceof RequestBodyTooLargeError)) throw error;
      throw new StripeBoundaryError("PAYLOAD_TOO_LARGE", "Stripe webhook payload is too large", {
        httpStatus: 413,
      });
    }

    const result = await getStripeWebhookAdapter().handle(rawBody, request.headers);
    return json({ received: true, ...result }, 200);
  } catch (error) {
    const boundaryError = asStripeBoundaryError(error);
    // Keep customer/provider responses generic; detailed state is recorded on WebhookEvent.
    console.error("Stripe webhook rejected", {
      code: boundaryError.code,
      retryable: boundaryError.retryable,
    });
    return json(
      { received: false, code: boundaryError.code },
      boundaryError.httpStatus,
    );
  }
}
