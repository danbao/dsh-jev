/**
 * Error taxonomy for the System One client.
 *
 * Every failure is classified, never stringified: callers and the tool
 * boundary branch on `code`, and only retryable codes are retried.
 *
 * @module dsh-jev/systemone/errors
 */

/** Machine-readable failure classification. */
export type JevErrorCode =
  /** The plugin or client was configured unusably (missing key, bad base URL). */
  | 'INVALID_CONFIG'
  /** A question or the request envelope failed local validation before any network call. */
  | 'INVALID_QUESTION'
  /** The service answered, but the payload did not satisfy the documented contract. */
  | 'INVALID_RESPONSE'
  /** 401 — missing or invalid API key. */
  | 'UNAUTHORIZED'
  /** 403 — the key is valid but not permitted. */
  | 'FORBIDDEN'
  /** 404 — endpoint or model not found. */
  | 'NOT_FOUND'
  /** 400/422 — the service rejected the request body. */
  | 'BAD_REQUEST'
  /** 429 — rate limited. */
  | 'RATE_LIMIT'
  /** 529 — the service is overloaded. */
  | 'OVERLOADED'
  /** 5xx other than 529. */
  | 'SERVER'
  /** The whole-call budget or a per-attempt timeout elapsed. */
  | 'TIMEOUT'
  /** The caller aborted. */
  | 'ABORTED'
  /** The request never reached a response (DNS, TLS, socket, malformed JSON). */
  | 'CONNECTION'
  /** Anything not otherwise classified. */
  | 'UNKNOWN'

/** Codes that may be retried with backoff. */
const RETRYABLE: ReadonlySet<JevErrorCode> = new Set<JevErrorCode>([
  'RATE_LIMIT',
  'OVERLOADED',
  'SERVER',
  'TIMEOUT',
  'CONNECTION',
])

/** A classified System One failure. */
export class JevError extends Error {
  /** Machine-readable classification. */
  readonly code: JevErrorCode
  /** Whether a retry with backoff may succeed. */
  readonly retryable: boolean
  /** HTTP status, when the failure came from a response. */
  readonly status: number | undefined
  /** Extra machine-readable detail (per-field violations, service message, …). */
  readonly detail: unknown

  constructor(
    code: JevErrorCode,
    message: string,
    options: { status?: number; detail?: unknown; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'JevError'
    this.code = code
    this.retryable = RETRYABLE.has(code)
    this.status = options.status
    this.detail = options.detail
  }
}

/** Whether an unknown thrown value is a {@link JevError}. */
export function isJevError(value: unknown): value is JevError {
  return value instanceof JevError
}

/** Map an HTTP status to a code. */
export function codeForStatus(status: number): JevErrorCode {
  switch (status) {
    case 400:
    case 422:
      return 'BAD_REQUEST'
    case 401:
      return 'UNAUTHORIZED'
    case 403:
      return 'FORBIDDEN'
    case 404:
      return 'NOT_FOUND'
    case 429:
      return 'RATE_LIMIT'
    case 529:
      return 'OVERLOADED'
    default:
      return status >= 500 ? 'SERVER' : 'UNKNOWN'
  }
}

/** Render any thrown value as a short, safe message. */
export function describeThrown(error: unknown): string {
  if (isJevError(error)) return `${error.code}: ${error.message}`
  if (error instanceof Error) return `${error.name}: ${error.message}`
  return String(error)
}
