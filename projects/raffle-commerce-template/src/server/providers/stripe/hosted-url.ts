import { StripeBoundaryError } from "./errors";

export function assertStripeHostedUrl(value: string | null | undefined, allowedHosts: readonly string[]) {
  if (!value) {
    throw new StripeBoundaryError(
      "PROCESSING_FAILED",
      "Stripe did not return a hosted redirect URL",
      { httpStatus: 502, retryable: true },
    );
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new StripeBoundaryError(
      "PROCESSING_FAILED",
      "Stripe returned an invalid hosted redirect URL",
      { httpStatus: 502, retryable: true, cause: error },
    );
  }
  if (url.protocol !== "https:" || url.username || url.password || !allowedHosts.includes(url.hostname)) {
    throw new StripeBoundaryError(
      "PROCESSING_FAILED",
      "Stripe returned an unexpected hosted redirect origin",
      { httpStatus: 502, retryable: true },
    );
  }
  return url.toString();
}
