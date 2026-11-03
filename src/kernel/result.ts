/**
 * Result type shared by every module. Errors never cross a module boundary as exceptions;
 * a function that can fail for a reason the caller must handle returns Result.
 */
export type ErrorCode =
  | "not_found"
  | "invalid" // input or file content violates the model
  | "conflict" // CAS version mismatch or a lease held by someone else
  | "refused" // an outcome check said no (e.g. a failed setup): exit 1
  | "io"; // the environment failed: filesystem, git, sqlite (exit 4, D-4)

export interface CanonError {
  readonly code: ErrorCode;
  readonly message: string;
}

export type Result<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: CanonError };

export const ok = <T>(value: T): Result<T> => ({ ok: true, value });
export const err = (code: ErrorCode, message: string): Result<never> => ({ ok: false, error: { code, message } });
