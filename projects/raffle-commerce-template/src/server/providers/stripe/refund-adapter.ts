import "server-only";

import { getStripeClient } from "./client";
import { StripeSdkRefundBoundary } from "./refund-adapter-core";

export type {
  CreateStripeRefundInput,
  StripeRefundBoundary,
  StripeRefundReason,
  StripeRefundResult,
} from "./refund-adapter-core";

export function createStripeRefundBoundary() {
  return new StripeSdkRefundBoundary(getStripeClient());
}
