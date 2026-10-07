export type ErrorCode =
  | "VALIDATION"
  | "INVALID_MASS"
  | "EMPTY_MIXTURE"
  | "ZERO_TOTAL"
  | "NO_FLOUR"
  | "UNKNOWN_VERSION"
  | "CYCLE"
  | "TOO_DEEP"
  | "TOO_MANY_ITEMS"
  | "NOT_FOUND"
  | "CONFLICT";

export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: unknown;

  constructor(code: ErrorCode, message: string, status = 400, details?: unknown) {
    super(message);
    this.code = code;
    this.status = status;
    this.details = details;
  }

  toJSON() {
    return { error: { code: this.code, message: this.message, details: this.details ?? null } };
  }
}
