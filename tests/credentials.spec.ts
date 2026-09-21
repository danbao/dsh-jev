/**
 * API key resolution order and per-call re-resolution.
 *
 * The credentials seam is optional in real profiles, so the fallback chain and
 * the "never cache the key" behaviour are both part of the contract.
 */

import type { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveSettings, type Config } from '../src/config.js'
import { createApiKeyResolver, describeApiKey } from '../src/credentials.js'
import { JevError } from '../src/systemone/errors.js'

/** A credentials provider stub recording every reference it is asked about. */
function fakeCredentials(values: Map<string, string>): {
  provider: { resolve: (ref: string) => Promise<{ value: string; source: string } | undefined>; describe: (ref: string) => Promise<{ configured: boolean; source?: string; writable: boolean }> }
  asks: string[]
} {
  const asks: string[] = []
  return {
    asks,
    provider: {
      resolve: async (ref: string) => {
        asks.push(ref)
        const value = values.get(ref)
        return value === undefined ? undefined : { value, source: 'file' }
      },
      describe: async (ref: string) => {
        asks.push(ref)
        const value = values.get(ref)
        return value === undefined
          ? { configured: false, writable: true }
          : { configured: true, source: 'file', writable: true }
      },
    },
  }
}

/** A context exposing only the credentials seam (or nothing). */
function contextWith(credentials: unknown): Context {
  return {
    get: (name: string) => (name === 'credentials' ? credentials : undefined),
  } as unknown as Context
}

const ENV_NAME = 'DSH_JEV_TEST_API_KEY'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('createApiKeyResolver', () => {
  it('prefers a literal apiKey over every other source', async () => {
    vi.stubEnv(ENV_NAME, 'from-env')
    const { provider, asks } = fakeCredentials(new Map([[ENV_NAME, 'from-credentials']]))
    const resolve = createApiKeyResolver(
      contextWith(provider),
      () => resolveSettings({ apiKey: 'from-config', apiKeyEnv: ENV_NAME }),
    )
    await expect(resolve()).resolves.toBe('from-config')
    // A literal override must not even consult the credential plane.
    expect(asks).toHaveLength(0)
  })

  it('resolves through the credentials service before the environment', async () => {
    vi.stubEnv(ENV_NAME, 'from-env')
    const { provider, asks } = fakeCredentials(new Map([[ENV_NAME, 'from-credentials']]))
    const resolve = createApiKeyResolver(contextWith(provider), () => resolveSettings({ apiKeyEnv: ENV_NAME }))
    await expect(resolve()).resolves.toBe('from-credentials')
    expect(asks).toEqual([ENV_NAME])
  })

  it('falls back to the process environment when the seam is absent or empty', async () => {
    vi.stubEnv(ENV_NAME, 'from-env')
    const withoutSeam = createApiKeyResolver(contextWith(undefined), () => resolveSettings({ apiKeyEnv: ENV_NAME }))
    await expect(withoutSeam()).resolves.toBe('from-env')

    const { provider } = fakeCredentials(new Map())
    const emptySeam = createApiKeyResolver(contextWith(provider), () => resolveSettings({ apiKeyEnv: ENV_NAME }))
    await expect(emptySeam()).resolves.toBe('from-env')
  })

  it('returns undefined when nothing is configured, and treats blank as absent', async () => {
    const { provider } = fakeCredentials(new Map())
    const resolve = createApiKeyResolver(contextWith(provider), () => resolveSettings({ apiKeyEnv: ENV_NAME }))
    await expect(resolve()).resolves.toBeUndefined()

    vi.stubEnv(ENV_NAME, '   ')
    await expect(resolve()).resolves.toBeUndefined()
  })

  it('re-resolves on every call so a rotated key needs no restart', async () => {
    const values = new Map([[ENV_NAME, 'first-key']])
    const { provider } = fakeCredentials(values)
    const resolve = createApiKeyResolver(contextWith(provider), () => resolveSettings({ apiKeyEnv: ENV_NAME }))
    await expect(resolve()).resolves.toBe('first-key')
    values.set(ENV_NAME, 'rotated-key')
    await expect(resolve()).resolves.toBe('rotated-key')
  })

  it('reads the current settings rather than the ones captured at build time', async () => {
    const { provider } = fakeCredentials(new Map([['SECOND_KEY', 'second-value']]))
    let current: Config = { apiKeyEnv: 'FIRST_KEY' }
    const resolve = createApiKeyResolver(contextWith(provider), () => resolveSettings(current))
    await expect(resolve()).resolves.toBeUndefined()
    current = { apiKeyEnv: 'SECOND_KEY' }
    await expect(resolve()).resolves.toBe('second-value')
  })

  it('rejects an apiKeyEnv that is not a valid credential reference', async () => {
    const { provider } = fakeCredentials(new Map())
    const resolve = createApiKeyResolver(contextWith(provider), () => resolveSettings({ apiKeyEnv: 'not.a.ref' }))
    await expect(resolve()).rejects.toThrowError(JevError)
    await expect(resolve()).rejects.toMatchObject({ code: 'INVALID_CONFIG' })
  })

  it('uses the per-backend default credential reference', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'openrouter-value')
    const { provider, asks } = fakeCredentials(new Map())
    const resolve = createApiKeyResolver(contextWith(provider), () => resolveSettings({}))
    await expect(resolve()).resolves.toBe('openrouter-value')
    expect(asks).toEqual(['OPENROUTER_API_KEY'])
  })
})

describe('describeApiKey', () => {
  it('reports presence and source without exposing the value', async () => {
    const { provider } = fakeCredentials(new Map([[ENV_NAME, 'secret-value']]))
    const status = await describeApiKey(contextWith(provider), () => resolveSettings({ apiKeyEnv: ENV_NAME }))
    expect(status).toEqual({ configured: true, source: 'file', reference: ENV_NAME })
    expect(JSON.stringify(status)).not.toContain('secret-value')
  })

  it('reports the environment layer and the unconfigured case', async () => {
    vi.stubEnv(ENV_NAME, 'from-env')
    const { provider } = fakeCredentials(new Map())
    await expect(describeApiKey(contextWith(provider), () => resolveSettings({ apiKeyEnv: ENV_NAME })))
      .resolves.toMatchObject({ configured: true, source: 'environment' })

    vi.unstubAllEnvs()
    await expect(describeApiKey(contextWith(provider), () => resolveSettings({ apiKeyEnv: ENV_NAME })))
      .resolves.toMatchObject({ configured: false, reference: ENV_NAME })
  })
})
