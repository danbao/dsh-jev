/**
 * The System One HTTP client.
 *
 * One implementation serves both backends, because the contract is identical:
 * TypeSafe exposes it at `https://api.typesafe.ai` and OpenRouter re-implements
 * it at `https://openrouter.ai/api`, so only the base URL, the API key, and the
 * model id spelling differ. No vendor SDK is involved — the request is a plain
 * `fetch`, which keeps the plugin's dependency surface to the harness itself.
 *
 * See https://openrouter.ai/docs/guides/community/typesafe-sdk.
 *
 * @module dsh-jev/systemone/client
 */

import { JevError, codeForStatus, describeThrown } from './errors.js'
import {
  DEFAULT_QUESTION_LIMITS,
  boundState,
  validateQuestions,
  type QuestionLimits,
} from './questions.js'
import type { Questions, SystemOneResponse } from './types.js'
import { validateReply, type ValidatedReply } from './validate.js'

/** Injectable logging seam; a subset of the harness logger. */
export interface JevLogger {
  warn(message: string, meta?: Record<string, unknown>): void
  info?(message: string, meta?: Record<string, unknown>): void
}

/** Client configuration. */
export interface SystemOneClientOptions {
  /** Backend base URL; `/v1/systemone` is appended. */
  baseURL: string
  /** Resolve the API key per call, so a rotated key takes effect without a restart. */
  resolveApiKey: () => Promise<string | undefined>
  /** Resolve the model id per call. */
  resolveModel: () => string
  /** Per-attempt timeout in milliseconds. */
  timeoutMs: number
  /** Whole-call budget in milliseconds, covering every attempt and its backoff. */
  budgetMs: number
  /** Retries after the first attempt (0 disables retrying). */
  maxRetries: number
  /** Local validation bounds. */
  limits?: QuestionLimits
  /** Optional OpenRouter attribution headers. */
  appName?: string
  appUrl?: string
  /** Injected for tests; defaults to the global fetch. */
  fetch?: typeof globalThis.fetch
  /** Optional logger. */
  logger?: JevLogger
}

/** One evaluation request. */
export interface EvaluateInput {
  /** The content to evaluate; text or structured JSON data. */
  state: unknown
  /** Typed questions, keyed by caller-chosen ids. */
  questions: Questions
  /** Caller cancellation. */
  signal?: AbortSignal
}

/** Retry backoff bounds. */
const BASE_BACKOFF_MS = 400
const MAX_BACKOFF_MS = 8_000

/** Read `Retry-After` (seconds or HTTP date) into a millisecond delay. */
function retryAfterMs(header: string | null): number | undefined {
  if (header === null) return undefined
  const seconds = Number(header)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, MAX_BACKOFF_MS)
  const date = Date.parse(header)
  if (Number.isNaN(date)) return undefined
  return Math.min(Math.max(date - Date.now(), 0), MAX_BACKOFF_MS)
}

/** Sleep that rejects promptly when the signal aborts. */
function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    // Surface the abort's own reason: a budget expiry must stay classified as
    // TIMEOUT rather than degrading into a caller-abort.
    const abort = (): never => {
      const reason: unknown = signal.reason
      throw reason instanceof JevError ? reason : new JevError('ABORTED', 'the request was aborted while waiting to retry')
    }
    if (signal.aborted) {
      try {
        abort()
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)))
      }
      return
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    function onAbort(): void {
      clearTimeout(timer)
      try {
        abort()
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/** What one attempt produced: a decoded body, or the classified failure to retry on. */
type AttemptOutcome =
  | { readonly ok: true; readonly body: unknown }
  | { readonly ok: false; readonly error: JevError }

/** The System One client. Stateless apart from its options. */
export class SystemOneClient {
  readonly #options: SystemOneClientOptions

  constructor(options: SystemOneClientOptions) {
    if (options.baseURL.trim().length === 0) {
      throw new JevError('INVALID_CONFIG', 'baseURL must be a non-empty absolute URL')
    }
    try {
      // Fail loudly here rather than as an opaque fetch error on the first call.
      new URL(options.baseURL)
    } catch {
      throw new JevError('INVALID_CONFIG', `baseURL is not a valid URL: ${options.baseURL}`)
    }
    if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
      throw new JevError('INVALID_CONFIG', 'timeoutMs must be a positive number')
    }
    if (!Number.isFinite(options.budgetMs) || options.budgetMs <= 0) {
      throw new JevError('INVALID_CONFIG', 'budgetMs must be a positive number')
    }
    if (!Number.isInteger(options.maxRetries) || options.maxRetries < 0) {
      throw new JevError('INVALID_CONFIG', 'maxRetries must be a non-negative integer')
    }
    this.#options = options
  }

  /** The absolute evaluation endpoint. */
  get endpoint(): string {
    return `${this.#options.baseURL.replace(/\/+$/, '')}/v1/systemone`
  }

  /** The effective local validation bounds. */
  get limits(): QuestionLimits {
    return this.#options.limits ?? DEFAULT_QUESTION_LIMITS
  }

  /**
   * Evaluate `state` against `questions`.
   * @param input - state, questions, and optional cancellation.
   * @returns the validated reply.
   * @throws {JevError} classified failures; `INVALID_*` never reaches the network.
   */
  async evaluate(input: EvaluateInput): Promise<ValidatedReply> {
    // A cancelled turn must not validate, resolve a key, or open a socket.
    if (input.signal?.aborted === true) {
      const reason: unknown = input.signal.reason
      throw reason instanceof JevError
        ? reason
        : new JevError('ABORTED', 'the request was aborted by the caller')
    }
    // Validate locally first: a malformed question must not cost a round trip.
    validateQuestions(input.questions, this.limits)
    const state = boundState(input.state, this.limits)

    const apiKey = await this.#options.resolveApiKey()
    if (apiKey === undefined || apiKey.trim().length === 0) {
      throw new JevError(
        'INVALID_CONFIG',
        'no Jev API key is configured: set apiKeyEnv to a configured credential, or store the key in the credentials service',
      )
    }

    const model = this.#options.resolveModel()
    if (model.trim().length === 0) {
      throw new JevError('INVALID_CONFIG', 'model must be a non-empty string')
    }

    const body = JSON.stringify({ model, state, questions: input.questions } satisfies Record<string, unknown>)
    const controller = new AbortController()
    const budgetTimer = setTimeout(() => {
      controller.abort(new JevError('TIMEOUT', `the whole-call budget of ${this.#options.budgetMs} ms elapsed`))
    }, this.#options.budgetMs)
    const signals = input.signal === undefined
      ? [controller.signal]
      : [input.signal, controller.signal]
    const signal = AbortSignal.any(signals)

    try {
      let lastError: JevError | undefined
      for (let attempt = 0; attempt <= this.#options.maxRetries; attempt += 1) {
        if (attempt > 0) {
          const backoff = Math.min(BASE_BACKOFF_MS * 2 ** (attempt - 1), MAX_BACKOFF_MS)
          await delay(lastError?.status === undefined ? backoff : backoff, signal)
        }
        const outcome = await this.#attempt(body, apiKey, signal)
        if (outcome.ok) return validateReply(outcome.body, input.questions)
        lastError = outcome.error
        if (!outcome.error.retryable) throw outcome.error
        this.#options.logger?.warn('jev request failed; will retry', {
          code: outcome.error.code,
          attempt: attempt + 1,
          maxRetries: this.#options.maxRetries,
          message: outcome.error.message,
        })
      }
      throw lastError ?? new JevError('UNKNOWN', 'the request failed without a classified error')
    } finally {
      clearTimeout(budgetTimer)
    }
  }

  /** Perform one HTTP attempt and classify its outcome. */
  async #attempt(body: string, apiKey: string, signal: AbortSignal): Promise<AttemptOutcome> {
    const fetchImpl = this.#options.fetch ?? globalThis.fetch
    const headers: Record<string, string> = {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    }
    if (this.#options.appName !== undefined) headers['X-Title'] = this.#options.appName
    if (this.#options.appUrl !== undefined) headers['HTTP-Referer'] = this.#options.appUrl

    let response: Response
    try {
      response = await fetchImpl(this.endpoint, {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.any([signal, AbortSignal.timeout(this.#options.timeoutMs)]),
      })
    } catch (error) {
      if (signal.aborted) {
        const reason: unknown = signal.reason
        if (reason instanceof JevError) return { ok: false, error: reason }
        return { ok: false, error: new JevError('ABORTED', 'the request was aborted by the caller', { cause: error }) }
      }
      if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
        return {
          ok: false,
          error: new JevError('TIMEOUT', `the request exceeded ${this.#options.timeoutMs} ms`, { cause: error }),
        }
      }
      return {
        ok: false,
        error: new JevError('CONNECTION', `the request to ${this.endpoint} failed: ${describeThrown(error)}`, { cause: error }),
      }
    }

    const text = await response.text().catch(() => '')
    const decoded = decodeJson(text)

    if (!response.ok) {
      const code = codeForStatus(response.status)
      const serviceMessage = readServiceMessage(decoded)
      const error = new JevError(
        code,
        serviceMessage ?? `the service answered ${response.status} ${response.statusText}`,
        { status: response.status, detail: decoded },
      )
      const retryAfter = retryAfterMs(response.headers.get('retry-after'))
      // Surface the service's own pacing hint on the error for logging.
      ;(error as { retryAfterMs?: number }).retryAfterMs = retryAfter
      return { ok: false, error }
    }

    if (decoded === undefined) {
      return {
        ok: false,
        error: new JevError('INVALID_RESPONSE', 'the service returned a body that is not valid JSON', {
          status: response.status,
          detail: text.slice(0, 500),
        }),
      }
    }
    return { ok: true, body: decoded }
  }
}

/** Decode a JSON body, returning `undefined` when it is absent or malformed. */
function decodeJson(text: string): unknown {
  if (text.trim().length === 0) return undefined
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

/** Pull a human-readable message out of a service error body. */
function readServiceMessage(decoded: unknown): string | undefined {
  if (typeof decoded !== 'object' || decoded === null) return undefined
  const record = decoded as Record<string, unknown>
  for (const key of ['error', 'message', 'detail']) {
    const value = record[key]
    if (typeof value === 'string' && value.length > 0) return value
    if (typeof value === 'object' && value !== null) {
      const nested = (value as Record<string, unknown>).message
      if (typeof nested === 'string' && nested.length > 0) return nested
    }
  }
  return undefined
}

/** Convenience re-export for callers that only need the response shape. */
export type { SystemOneResponse }
