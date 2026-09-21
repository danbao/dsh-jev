/**
 * API key resolution.
 *
 * The key is resolved **per call** and never cached, so a rotated key reaches
 * the next evaluation without a restart. Resolution order:
 *
 * 1. the literal `apiKey` config value, when set (an explicit override),
 * 2. the credentials service (`ctx.credentials`), which itself layers the
 *    process environment, provider-managed storage, and `.env` files,
 * 3. `process.env` directly, for profiles where the credentials seam is not
 *    mounted.
 *
 * Step 3 exists because the seam is genuinely optional: on some desktop
 * profiles `ctx.get('credentials')` returns `undefined` even though the
 * environment carries the key.
 *
 * @module dsh-jev/credentials
 */

import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { JevError } from './systemone/errors.js'
import type { ResolvedSettings } from './config.js'

/** Presence facts about the configured key, safe to log or show in a UI. */
export interface ApiKeyStatus {
  /** Whether a key would currently resolve. */
  configured: boolean
  /** Where the value came from, when known. */
  source: string | undefined
  /** The credential reference that was consulted. */
  reference: string
}

/** Read the ambient environment value, treating blank as absent. */
function fromEnvironment(name: string): string | undefined {
  const value = process.env[name]
  return value !== undefined && value.trim().length > 0 ? value : undefined
}

/**
 * Build a resolver that reads the current settings on every call.
 * @param ctx - plugin context, used to reach the credentials service.
 * @param settings - reads the currently authoritative settings.
 * @returns a resolver returning the key, or `undefined` when unconfigured.
 */
export function createApiKeyResolver(
  ctx: Context,
  settings: () => ResolvedSettings,
): () => Promise<string | undefined> {
  return async () => {
    const current = settings()
    if (current.apiKey !== undefined) return current.apiKey

    let ref: ReturnType<typeof credentialRef>
    try {
      ref = credentialRef(current.apiKeyEnv)
    } catch (error) {
      throw new JevError(
        'INVALID_CONFIG',
        `apiKeyEnv is not a valid credential reference: ${current.apiKeyEnv}`,
        { cause: error },
      )
    }

    const credentials = ctx.get('credentials')
    if (credentials !== undefined) {
      const hit = await credentials.resolve(ref)
      if (hit !== undefined && hit.value.trim().length > 0) return hit.value
    }

    return fromEnvironment(current.apiKeyEnv)
  }
}

/**
 * Describe whether a key is configured, without ever returning its value.
 * @param ctx - plugin context.
 * @param settings - reads the currently authoritative settings.
 * @returns presence facts for logging and configuration surfaces.
 */
export async function describeApiKey(
  ctx: Context,
  settings: () => ResolvedSettings,
): Promise<ApiKeyStatus> {
  const current = settings()
  if (current.apiKey !== undefined) {
    return { configured: true, source: 'config:apiKey', reference: current.apiKeyEnv }
  }

  let ref: ReturnType<typeof credentialRef>
  try {
    ref = credentialRef(current.apiKeyEnv)
  } catch {
    return { configured: false, source: undefined, reference: current.apiKeyEnv }
  }

  const credentials = ctx.get('credentials')
  if (credentials !== undefined) {
    const info = await credentials.describe(ref)
    if (info.configured) {
      return { configured: true, source: info.source ?? 'credentials', reference: current.apiKeyEnv }
    }
  }

  const ambient = fromEnvironment(current.apiKeyEnv)
  if (ambient !== undefined) {
    return { configured: true, source: 'environment', reference: current.apiKeyEnv }
  }
  return { configured: false, source: undefined, reference: current.apiKeyEnv }
}
