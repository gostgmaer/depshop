export const ErrorCode = {
  BAD_REQUEST: "BAD_REQUEST",
  VALIDATION_ERROR: "VALIDATION_ERROR",
  UNAUTHENTICATED: "UNAUTHENTICATED",
  FORBIDDEN: "FORBIDDEN",
  CSRF_INVALID: "CSRF_INVALID",
  NOT_FOUND: "NOT_FOUND",
  CONFLICT: "CONFLICT",
  RATE_LIMITED: "RATE_LIMITED",
  USAGE_LIMIT_EXCEEDED: "USAGE_LIMIT_EXCEEDED",
  /// The feature isn't part of the caller's current plan.
  PLAN_UPGRADE_REQUIRED: "PLAN_UPGRADE_REQUIRED",
  SOURCE_UNAVAILABLE: "SOURCE_UNAVAILABLE",
  SOURCE_TIMEOUT: "SOURCE_TIMEOUT",
  DEPENDENCY_UNAVAILABLE: "DEPENDENCY_UNAVAILABLE",
  INTERNAL: "INTERNAL",
} as const;
export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

const STATUS: Record<ErrorCode, number> = {
  BAD_REQUEST: 400,
  VALIDATION_ERROR: 422,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  CSRF_INVALID: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  RATE_LIMITED: 429,
  USAGE_LIMIT_EXCEEDED: 429,
  PLAN_UPGRADE_REQUIRED: 403,
  SOURCE_UNAVAILABLE: 502,
  SOURCE_TIMEOUT: 504,
  DEPENDENCY_UNAVAILABLE: 503,
  INTERNAL: 500,
};

/** Application error with a stable machine-readable code. */
export class AppError extends Error {
  override readonly name = "AppError";
  readonly statusCode: number;

  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.statusCode = STATUS[code];
  }

  static notFound(entity: string): AppError {
    return new AppError(ErrorCode.NOT_FOUND, `${entity} not found`);
  }
  static unauthenticated(message = "Authentication required"): AppError {
    return new AppError(ErrorCode.UNAUTHENTICATED, message);
  }
  static forbidden(message = "You do not have access to this resource"): AppError {
    return new AppError(ErrorCode.FORBIDDEN, message);
  }
  static conflict(message: string): AppError {
    return new AppError(ErrorCode.CONFLICT, message);
  }
}

/** Every API error response: `{ success: false, error, meta: { requestId } }`. */
export interface ErrorResponseBody {
  success: false;
  error: { code: ErrorCode; message: string; details?: unknown };
  meta: { requestId: string };
}
