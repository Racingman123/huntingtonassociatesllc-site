import { describe, expect, it, vi } from "vitest";
import { NotificationDeliveryError, type TransactionalEmail } from "./email";
import { getResendConfig, ResendEmailProvider } from "./resend";

const email: TransactionalEmail = {
  to: "customer@example.test",
  subject: "Receipt",
  html: "<p>Receipt</p>",
  text: "Receipt",
  replyTo: "support@example.test",
  templateVersion: "receipt_v1",
};

function fetchReturning(response: Response) {
  return vi.fn(async () => response) as unknown as typeof fetch;
}

describe("ResendEmailProvider", () => {
  it("posts one idempotent transactional request using native fetch", async () => {
    const fetchImplementation = fetchReturning(Response.json({ id: "email_123" }, { status: 200 }));
    const provider = new ResendEmailProvider({
      apiKey: "re_test_notification_key",
      from: "Test Sender <notices@example.test>",
    }, fetchImplementation);

    await expect(provider.send(email, "outbox/event-1/receipt_v1"))
      .resolves.toEqual({ providerMessageId: "email_123" });

    expect(fetchImplementation).toHaveBeenCalledOnce();
    const [url, request] = (fetchImplementation as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.resend.com/emails");
    expect(request.method).toBe("POST");
    expect(request.headers).toMatchObject({
      Authorization: "Bearer re_test_notification_key",
      "Idempotency-Key": "outbox/event-1/receipt_v1",
    });
    expect(JSON.parse(String(request.body))).toMatchObject({
      to: [email.to],
      subject: email.subject,
      html: email.html,
      text: email.text,
      reply_to: email.replyTo,
    });
  });

  it("classifies transient and permanent provider responses without retaining response details", async () => {
    const transient = new ResendEmailProvider({
      apiKey: "re_test_notification_key",
      from: "notices@example.test",
    }, fetchReturning(Response.json({ name: "rate_limit_exceeded", message: "contains sensitive context" }, { status: 429 })));
    const permanent = new ResendEmailProvider({
      apiKey: "re_test_notification_key",
      from: "notices@example.test",
    }, fetchReturning(Response.json({ name: "validation_error", message: "recipient customer@example.test" }, { status: 422 })));

    await expect(transient.send(email, "event/transient")).rejects.toMatchObject({
      code: "resend_rate_limit_exceeded",
      retryable: true,
      message: "Transactional email delivery failed",
    });
    await expect(permanent.send(email, "event/permanent")).rejects.toMatchObject({
      code: "resend_validation_error",
      retryable: false,
      message: "Transactional email delivery failed",
    });
  });

  it("keeps placeholder or malformed runtime configuration disabled", () => {
    expect(getResendConfig({ RESEND_API_KEY: "", EMAIL_FROM: "Sender <hello@example.com>" })).toBeNull();
    expect(getResendConfig({ RESEND_API_KEY: "replace-with-a-key", EMAIL_FROM: "notices@brand.test" })).toBeNull();
    expect(getResendConfig({ RESEND_API_KEY: "re_configured_key", EMAIL_FROM: "Brand <notices@brand.test>" }))
      .toEqual({ apiKey: "re_configured_key", from: "Brand <notices@brand.test>" });
    expect(() => new ResendEmailProvider({ apiKey: "short", from: "bad" }))
      .toThrowError(NotificationDeliveryError);
  });
});
