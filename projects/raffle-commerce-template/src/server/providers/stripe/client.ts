import "server-only";

import Stripe from "stripe";
import { StripeBoundaryError } from "./errors";
import type { StripeInvoiceReader } from "./mapping";

let stripeClient: Stripe | null = null;

function required(name: "STRIPE_SECRET_KEY" | "STRIPE_WEBHOOK_SECRET") {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new StripeBoundaryError("CONFIGURATION_ERROR", `${name} is not configured`, {
      httpStatus: 503,
      retryable: true,
    });
  }
  return value;
}

function configuredLivemode() {
  const configured = process.env.STRIPE_WEBHOOK_LIVEMODE?.trim().toLowerCase();
  if (configured && !["true", "false"].includes(configured)) {
    throw new StripeBoundaryError(
      "CONFIGURATION_ERROR",
      "STRIPE_WEBHOOK_LIVEMODE must be true or false",
      { httpStatus: 503, retryable: true },
    );
  }
  return configured ? configured === "true" : process.env.NODE_ENV === "production";
}

export function getStripeRuntimeConfig() {
  const apiVersion = process.env.STRIPE_WEBHOOK_API_VERSION?.trim() || Stripe.API_VERSION;
  if (apiVersion !== Stripe.API_VERSION) {
    throw new StripeBoundaryError(
      "CONFIGURATION_ERROR",
      `STRIPE_WEBHOOK_API_VERSION must match the installed Stripe SDK (${Stripe.API_VERSION})`,
      { httpStatus: 503, retryable: true },
    );
  }
  return {
    secretKey: required("STRIPE_SECRET_KEY"),
    webhookSecret: required("STRIPE_WEBHOOK_SECRET"),
    apiVersion,
    livemode: configuredLivemode(),
  };
}

export function getStripeClient() {
  if (stripeClient) return stripeClient;
  const config = getStripeRuntimeConfig();
  stripeClient = new Stripe(config.secretKey, {
    apiVersion: Stripe.API_VERSION,
    maxNetworkRetries: 2,
    timeout: 20_000,
    appInfo: {
      name: "giveaway-site-template",
      version: "1.0.0",
    },
  });
  return stripeClient;
}

export function createStripeInvoiceReader(client = getStripeClient()): StripeInvoiceReader {
  return {
    async retrieveInvoice(invoiceId) {
      return client.invoices.retrieve(invoiceId);
    },
    async listPaidInvoicePayments(invoiceId) {
      const payments = await client.invoicePayments.list({
        invoice: invoiceId,
        status: "paid",
        limit: 10,
      });
      if (payments.has_more) {
        throw new StripeBoundaryError(
          "INVALID_EVENT_SHAPE",
          "Subscription invoices with more than 10 paid payments are unsupported",
          { httpStatus: 422 },
        );
      }
      return payments.data;
    },
    async listInvoiceLineItems(invoiceId) {
      const lines = await client.invoices.listLineItems(invoiceId, { limit: 100 });
      if (lines.has_more) {
        throw new StripeBoundaryError(
          "INVALID_EVENT_SHAPE",
          "Subscription invoices with more than 100 line items are unsupported",
          { httpStatus: 422 },
        );
      }
      return lines.data;
    },
  };
}
