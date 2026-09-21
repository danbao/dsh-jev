/**
 * Plugin configuration.
 *
 * Every field carries a schema default, because a configuration surface renders
 * the schema-resolved section: a default that lives only at the use site reads
 * there as "no value at all".
 *
 * The API key is never a plain config literal by default — it is addressed as a
 * {@link https://docs.deepseek.ai credential reference} (`apiKeyEnv`) so it can
 * be resolved from the credentials service, the process environment, or a
 * `.env` file, and so a rotated key takes effect on the next call.
 *
 * @module dsh-jev/config
 */

import z from '@deepseek-ai/schemastery'
import { DEFAULT_QUESTION_LIMITS, type QuestionLimits } from './systemone/questions.js'

/** The backend serving the System One contract. */
export type JevBackend = 'openrouter' | 'typesafe'

/** Backend default base URL; `/v1/systemone` is appended. */
export const BACKEND_BASE_URL: Readonly<Record<JevBackend, string>> = Object.freeze({
  openrouter: 'https://openrouter.ai/api',
  typesafe: 'https://api.typesafe.ai',
})

/**
 * Backend default model id. OpenRouter maps `jev-1.13` to `typesafe/jev-1.13`
 * and `jev-latest` to its `~typesafe/jev-latest` alias; TypeSafe serves the
 * versioned ids and aliases directly.
 */
export const BACKEND_DEFAULT_MODEL: Readonly<Record<JevBackend, string>> = Object.freeze({
  openrouter: 'jev-1.13',
  typesafe: 'jev-latest',
})

/** Default credential reference per backend. */
export const BACKEND_DEFAULT_API_KEY_ENV: Readonly<Record<JevBackend, string>> = Object.freeze({
  openrouter: 'OPENROUTER_API_KEY',
  typesafe: 'TYPESAFE_API_KEY',
})

/** Settings namespace carrying this plugin's live section. */
export const JEV_SETTINGS_NAMESPACE = 'jev'

/** Plugin config as authored in `cordis.yml`. */
export interface Config {
  /** Backend serving the System One contract. Defaults to `openrouter`. */
  backend?: JevBackend
  /** Credential reference holding the API key. Defaults per backend. */
  apiKeyEnv?: string
  /** Literal API key. Prefer {@link apiKeyEnv} so no secret enters a config file. */
  apiKey?: string
  /** Override the backend base URL (self-hosted or gateway deployment). */
  baseURL?: string
  /** Model id. Defaults per backend. */
  model?: string
  /** Per-attempt timeout in milliseconds. Defaults to 20000. */
  timeoutMs?: number
  /** Whole-call budget in milliseconds, covering retries. Defaults to 45000. */
  budgetMs?: number
  /** Retries after the first attempt. Defaults to 1. */
  maxRetries?: number
  /** Maximum questions in one call. Defaults to 64. */
  maxQuestions?: number
  /** Maximum characters of the serialized `state`. Defaults to 96000. */
  maxStateChars?: number
  /** Maximum characters of one instruction string. Defaults to 8000. */
  maxInstructionChars?: number
  /** OpenRouter attribution title, sent as `X-Title`. */
  appName?: string
  /** OpenRouter attribution URL, sent as `HTTP-Referer`. */
  appUrl?: string
  /** Emit a log line per evaluation. Defaults to true. */
  logRequests?: boolean
}

/** Schemastery schema for {@link Config}. */
export const Config: z<Config> = z.object({
  backend: z.union(['openrouter', 'typesafe'] as const).default('openrouter'),
  apiKeyEnv: z.string().role('credential-ref'),
  apiKey: z.string().role('secret'),
  baseURL: z.string(),
  model: z.string(),
  timeoutMs: z.natural().min(1).default(20_000),
  budgetMs: z.natural().min(1).default(45_000),
  maxRetries: z.natural().default(1),
  maxQuestions: z.natural().min(1).default(DEFAULT_QUESTION_LIMITS.maxQuestions),
  maxStateChars: z.natural().min(1).default(DEFAULT_QUESTION_LIMITS.maxStateChars),
  maxInstructionChars: z.natural().min(1).default(DEFAULT_QUESTION_LIMITS.maxInstructionChars),
  appName: z.string().default('dsh-jev'),
  appUrl: z.string(),
  logRequests: z.boolean().default(true),
})

/** Fully resolved settings, with every default applied. */
export interface ResolvedSettings {
  backend: JevBackend
  apiKeyEnv: string
  apiKey: string | undefined
  baseURL: string
  model: string
  timeoutMs: number
  budgetMs: number
  maxRetries: number
  appName: string
  appUrl: string | undefined
  logRequests: boolean
  limits: QuestionLimits
}

/**
 * Apply defaults, including the per-backend ones the schema cannot express.
 * @param config - the currently authoritative section.
 * @returns fully resolved settings.
 */
export function resolveSettings(config: Config): ResolvedSettings {
  const backend: JevBackend = config.backend ?? 'openrouter'
  const apiKey = config.apiKey !== undefined && config.apiKey.trim().length > 0 ? config.apiKey : undefined
  return {
    backend,
    apiKeyEnv: config.apiKeyEnv ?? BACKEND_DEFAULT_API_KEY_ENV[backend],
    apiKey,
    baseURL: config.baseURL ?? BACKEND_BASE_URL[backend],
    model: config.model ?? BACKEND_DEFAULT_MODEL[backend],
    timeoutMs: config.timeoutMs ?? 20_000,
    budgetMs: config.budgetMs ?? 45_000,
    maxRetries: config.maxRetries ?? 1,
    appName: config.appName ?? 'dsh-jev',
    appUrl: config.appUrl,
    logRequests: config.logRequests ?? true,
    limits: {
      ...DEFAULT_QUESTION_LIMITS,
      maxQuestions: config.maxQuestions ?? DEFAULT_QUESTION_LIMITS.maxQuestions,
      maxStateChars: config.maxStateChars ?? DEFAULT_QUESTION_LIMITS.maxStateChars,
      maxInstructionChars: config.maxInstructionChars ?? DEFAULT_QUESTION_LIMITS.maxInstructionChars,
    },
  }
}
