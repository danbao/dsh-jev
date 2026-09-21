/**
 * `dsh-jev` — TypeSafe Jev (System One) typed decisions for DeepSeek Harness.
 *
 * Registers one model-facing tool, `jev_ask`, that sends a state and a set of
 * typed questions to a System One model and returns structured answers. The
 * same implementation serves both backends, because OpenRouter re-implements
 * TypeSafe's System One contract:
 *
 * - `openrouter` (default) → `https://openrouter.ai/api/v1/systemone`
 * - `typesafe`             → `https://api.typesafe.ai/v1/systemone`
 *
 * The API key is resolved per call through the credentials service, so a
 * rotated key needs no restart. A missing key does **not** block plugin load;
 * the first `jev_ask` call reports it as an actionable error instead.
 *
 * @module dsh-jev
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-tools'

import {
  Config,
  JEV_SETTINGS_NAMESPACE,
  resolveSettings,
  type Config as JevConfig,
} from './config.js'
import { createApiKeyResolver, describeApiKey } from './credentials.js'
import { JEV_ASK_TOOL_NAME, createJevAskTool } from './tool.js'
import type { JevLogger } from './systemone/client.js'
import { describeThrown } from './systemone/errors.js'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'dsh-jev'

/** The tool registry this plugin registers into. */
export const inject = ['tools']

export { Config }
export type { Config as JevConfig } from './config.js'
export { JEV_ASK_TOOL_NAME, createJevAskTool } from './tool.js'
export { SystemOneClient } from './systemone/client.js'
export type { SystemOneClientOptions, EvaluateInput, JevLogger } from './systemone/client.js'
export { JevError, isJevError, describeThrown, type JevErrorCode } from './systemone/errors.js'
export {
  DEFAULT_QUESTION_LIMITS,
  boundState,
  choice,
  noul,
  score,
  validateQuestions,
  type QuestionLimits,
} from './systemone/questions.js'
export { validateReply, type ValidatedReply } from './systemone/validate.js'
export type {
  Answer,
  Answers,
  ChoiceAnswer,
  ChoiceQuestion,
  Instructions,
  NoulAnswer,
  NoulQuestion,
  Question,
  QuestionType,
  Questions,
  ScoreAnswer,
  ScoreQuestion,
  SystemOneRequest,
  SystemOneResponse,
  Usage,
} from './systemone/types.js'

/** The subset of the Cordis logger this plugin uses. */
interface CordisLoggerLike {
  info?(message: string): void
  warn?(message: string): void
}

/** Adapt the harness logger, tolerating profiles without one. */
function loggerFrom(ctx: Context): JevLogger | undefined {
  const logger = (ctx as unknown as { logger?: CordisLoggerLike }).logger
  if (logger === undefined) return undefined
  const write = (level: 'info' | 'warn', message: string, meta?: Record<string, unknown>): void => {
    const sink = logger[level]
    if (typeof sink !== 'function') return
    sink.call(logger, meta === undefined ? message : `${message} ${JSON.stringify(meta)}`)
  }
  return {
    warn: (message, meta) => write('warn', message, meta),
    info: (message, meta) => write('info', message, meta),
  }
}

/**
 * Reject a section that parses but cannot work, so the settings document and the
 * running plugin never disagree.
 * @param value - the candidate section.
 */
function validateSection(value: JevConfig): void {
  const resolved = resolveSettings(value)
  try {
    new URL(resolved.baseURL)
  } catch {
    throw new Error(`dsh-jev: baseURL is not a valid URL: ${resolved.baseURL}`)
  }
  if (resolved.timeoutMs > resolved.budgetMs) {
    throw new Error(
      `dsh-jev: timeoutMs (${resolved.timeoutMs}) must not exceed budgetMs (${resolved.budgetMs}); `
      + 'the per-attempt timeout cannot be larger than the whole-call budget',
    )
  }
}

/**
 * Register the `jev_ask` tool and this plugin's settings section.
 * @param ctx - plugin context.
 * @param config - the composed configuration entry (the base layer).
 */
export function apply(ctx: Context, config: JevConfig): void {
  let current: () => JevConfig = () => config
  const settings = (): ReturnType<typeof resolveSettings> => resolveSettings(current())
  const logger = loggerFrom(ctx)

  // The composed config must be usable at load time; a missing API key is
  // deliberately NOT a load failure (it is reported per call instead).
  validateSection(config)

  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.settings.installSection(ctx, JEV_SETTINGS_NAMESPACE, Config, config, {
      setSource: (source) => {
        current = source
      },
      // Every read goes through `settings()`, so a committed change needs no
      // re-registration: the next call picks it up.
      onChange: () => {},
      validate: validateSection,
    })
  })

  const resolveApiKey = createApiKeyResolver(ctx, settings)
  ctx.tools.register(createJevAskTool({
    settings,
    resolveApiKey: () => resolveApiKey(),
    ...logger === undefined ? {} : { logger },
  }))

  // Report key presence once at load so a misconfigured profile is visible
  // before the first tool call, without failing the load.
  void describeApiKey(ctx, settings).then(
    (status) => {
      if (!status.configured) {
        logger?.warn?.(
          `dsh-jev: no API key configured for the "${settings().backend}" backend; `
          + `${JEV_ASK_TOOL_NAME} will fail until a credential for "${status.reference}" is set`,
        )
        return
      }
      logger?.info?.(`dsh-jev: ready (${settings().backend}, key from ${status.source ?? 'unknown'})`)
    },
    (error: unknown) => {
      logger?.warn?.(`dsh-jev: could not determine API key status: ${describeThrown(error)}`)
    },
  )
}
