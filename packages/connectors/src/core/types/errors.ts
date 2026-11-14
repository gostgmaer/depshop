/** Categorized connector failures (used for retries, circuit breaking and metrics). */
export const ErrorCategory = {
  TIMEOUT: "TIMEOUT",
  RATE_LIMITED: "RATE_LIMITED",
  AUTH: "AUTH",
  NOT_CONFIGURED: "NOT_CONFIGURED",
  INVALID_RESPONSE: "INVALID_RESPONSE",
  UPSTREAM: "UPSTREAM",
  NETWORK: "NETWORK",
  CIRCUIT_OPEN: "CIRCUIT_OPEN",
  NOT_SUPPORTED: "NOT_SUPPORTED",
  UNKNOWN: "UNKNOWN",
} as const;
export type ErrorCategory = (typeof ErrorCategory)[keyof typeof ErrorCategory];

const RETRYABLE = new Set<ErrorCategory>(["TIMEOUT", "RATE_LIMITED", "UPSTREAM", "NETWORK"]);

export class ConnectorError extends Error {
  override readonly name = "ConnectorError";
  readonly retryable: boolean;

  constructor(
    readonly category: ErrorCategory,
    message: string,
    options: { retryable?: boolean; retryAfterMs?: number; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.retryable = options.retryable ?? RETRYABLE.has(category);
    this.retryAfterMs = options.retryAfterMs;
  }

  readonly retryAfterMs: number | undefined;

  /** Maps HTTP status codes from an upstream API to a category. */
  static fromHttpStatus(status: number, message: string, retryAfterMs?: number): ConnectorError {
    if (status === 401 || status === 403) return new ConnectorError("AUTH", message);
    if (status === 429)
      return new ConnectorError("RATE_LIMITED", message, retryAfterMs ? { retryAfterMs } : {});
    if (status >= 500) return new ConnectorError("UPSTREAM", message);
    return new ConnectorError("UPSTREAM", message, { retryable: false });
  }
}

/** Normalizes anything thrown by a connector into a ConnectorError. */
export function toConnectorError(error: unknown): ConnectorError {
  if (error instanceof ConnectorError) return error;
  if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) {
    return new ConnectorError("TIMEOUT", "Request timed out", { cause: error });
  }
  if (error instanceof TypeError && /fetch|network|ECONN|ENOTFOUND/i.test(error.message)) {
    return new ConnectorError("NETWORK", error.message, { cause: error });
  }
  return new ConnectorError("UNKNOWN", error instanceof Error ? error.message : String(error), {
    cause: error,
    retryable: false,
  });
}
