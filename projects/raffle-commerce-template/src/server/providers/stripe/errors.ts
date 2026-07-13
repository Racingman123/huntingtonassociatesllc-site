export type StripeBoundaryErrorCode =
  | "CONFIGURATION_ERROR"
  | "DEMO_MODE_DISABLED"
  | "INVALID_SIGNATURE"
  | "INVALID_API_VERSION"
  | "INVALID_EVENT_MODE"
  | "UNSUPPORTED_CONNECT_EVENT"
  | "PAYLOAD_TOO_LARGE"
  | "INVALID_METADATA"
  | "INVALID_EVENT_SHAPE"
  | "IDENTITY_MISMATCH"
  | "PAYLOAD_CONFLICT"
  | "DELIVERY_IN_PROGRESS"
  | "PROCESSING_FAILED";

export class StripeBoundaryError extends Error {
  readonly code: StripeBoundaryErrorCode;
  readonly httpStatus: number;
  readonly retryable: boolean;

  constructor(
    code: StripeBoundaryErrorCode,
    message: string,
    options: { httpStatus?: number; retryable?: boolean; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "StripeBoundaryError";
    this.code = code;
    this.httpStatus = options.httpStatus ?? 422;
    this.retryable = options.retryable ?? false;
  }
}

export function asStripeBoundaryError(error: unknown) {
  if (error instanceof StripeBoundaryError) return error;
  return new StripeBoundaryError(
    "PROCESSING_FAILED",
    "Stripe event processing failed",
    { httpStatus: 500, retryable: true, cause: error },
  );
}

