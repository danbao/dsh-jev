/**
 * HTTP client behaviour: request shape, retry policy, and failure classification.
 * Every test injects `fetch`, so nothing here touches the network.
 */

import { describe, expect, it, vi } from 'vitest'
import { SystemOneClient } from '../src/systemone/client.js'
import { JevError } from '../src/systemone/errors.js'
import { noul } from '../src/systemone/questions.js'

/** The input type the global fetch accepts, without depending on DOM lib types. */
type FetchInput = Parameters<typeof globalThis.fetch>[0]

/** A recorded call to the injected fetch. */
interface Recorded {
  url: string
  init: RequestInit
}

/** Build a client whose fetch returns the given scripted responses in order. */
function clientWith(
  responses: Array<Response | Error | (() => Promise<Response>)>,
  overrides: Partial<ConstructorParameters<typeof SystemOneClient>[0]> = {},
): { client: SystemOneClient; calls: Recorded[] } {
  const calls: Recorded[] = []
  const fetchImpl = (async (input: FetchInput, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(input), init: init ?? {} })
    const next = responses[Math.min(calls.length - 1, responses.length - 1)]
    if (next === undefined) throw new Error('no scripted response left')
    if (next instanceof Error) throw next
    if (typeof next === 'function') return next()
    return next
  }) as unknown as typeof globalThis.fetch

  const client = new SystemOneClient({
    baseURL: 'https://openrouter.ai/api',
    resolveApiKey: () => Promise.resolve('test-key'),
    resolveModel: () => 'jev-1.13',
    timeoutMs: 5000,
    budgetMs: 10_000,
    maxRetries: 0,
    fetch: fetchImpl,
    ...overrides,
  })
  return { client, calls }
}

/** A JSON response. */
function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

const QUESTIONS = { urgent: noul('Is this urgent?') }
const OK_BODY = { model: 'typesafe/jev-1.13-20260917', answers: { urgent: { type: 'noul', noul: 0.95 } } }

describe('SystemOneClient request shape', () => {
  it('posts to <baseURL>/v1/systemone with bearer auth and the documented body', async () => {
    const { client, calls } = clientWith([json(OK_BODY)])
    const reply = await client.evaluate({ state: 'a charged twice', questions: QUESTIONS })

    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe('https://openrouter.ai/api/v1/systemone')
    const headers = calls[0]?.init.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer test-key')
    expect(headers['Content-Type']).toBe('application/json')

    const body = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>
    expect(body).toMatchObject({ model: 'jev-1.13', state: 'a charged twice' })
    expect(body.questions).toEqual({ urgent: { type: 'noul', instructions: 'Is this urgent?' } })
    expect(reply.answers.urgent).toEqual({ type: 'noul', noul: 0.95 })
  })

  it('normalizes a trailing slash in baseURL instead of doubling it', () => {
    const { client } = clientWith([], { baseURL: 'https://api.typesafe.ai/' })
    expect(client.endpoint).toBe('https://api.typesafe.ai/v1/systemone')
  })

  it('sends OpenRouter attribution headers only when configured', async () => {
    const bare = clientWith([json(OK_BODY)])
    await bare.client.evaluate({ state: 'x', questions: QUESTIONS })
    expect((bare.calls[0]?.init.headers as Record<string, string>)['X-Title']).toBeUndefined()

    const attributed = clientWith([json(OK_BODY)], { appName: 'dsh-jev', appUrl: 'https://example.test' })
    await attributed.client.evaluate({ state: 'x', questions: QUESTIONS })
    const headers = attributed.calls[0]?.init.headers as Record<string, string>
    expect(headers['X-Title']).toBe('dsh-jev')
    expect(headers['HTTP-Referer']).toBe('https://example.test')
  })

  it('rejects an invalid baseURL or non-positive timeout at construction', () => {
    expect(() => clientWith([], { baseURL: 'not a url' })).toThrowError(JevError)
    expect(() => clientWith([], { timeoutMs: 0 })).toThrowError(/timeoutMs must be a positive number/)
    expect(() => clientWith([], { maxRetries: -1 })).toThrowError(/maxRetries must be a non-negative integer/)
  })
})

describe('SystemOneClient local validation', () => {
  it('fails on a malformed question without making a request', async () => {
    const { client, calls } = clientWith([json(OK_BODY)])
    await expect(client.evaluate({
      state: 'x',
      questions: { bad: { type: 'score', instructions: 'Rate', criteria: ['only one'] } },
    })).rejects.toThrowError(/2–10/)
    expect(calls).toHaveLength(0)
  })

  it('fails when no API key resolves, without making a request', async () => {
    const { client, calls } = clientWith([json(OK_BODY)], { resolveApiKey: () => Promise.resolve(undefined) })
    await expect(client.evaluate({ state: 'x', questions: QUESTIONS }))
      .rejects.toThrowError(/no Jev API key is configured/)
    expect(calls).toHaveLength(0)
  })
})

describe('SystemOneClient failure classification', () => {
  it('does not retry a 401 and classifies it as UNAUTHORIZED', async () => {
    const { client, calls } = clientWith([json({ error: 'invalid key' }, 401)], { maxRetries: 2 })
    await expect(client.evaluate({ state: 'x', questions: QUESTIONS })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
      retryable: false,
    })
    expect(calls).toHaveLength(1)
  })

  it('surfaces the service message on a 422', async () => {
    const { client } = clientWith([json({ detail: 'questions.urgent.instructions is required' }, 422)])
    await expect(client.evaluate({ state: 'x', questions: QUESTIONS })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      status: 422,
      message: 'questions.urgent.instructions is required',
    })
  })

  it('retries a 429 and succeeds on the next attempt', async () => {
    const { client, calls } = clientWith(
      [json({ error: 'slow down' }, 429), json(OK_BODY)],
      { maxRetries: 1 },
    )
    const reply = await client.evaluate({ state: 'x', questions: QUESTIONS })
    expect(calls).toHaveLength(2)
    expect(reply.answers.urgent).toMatchObject({ noul: 0.95 })
  })

  it('gives up after the configured retries and reports the last failure', async () => {
    const { client, calls } = clientWith([json({ error: 'overloaded' }, 529)], { maxRetries: 2 })
    await expect(client.evaluate({ state: 'x', questions: QUESTIONS })).rejects.toMatchObject({
      code: 'OVERLOADED',
      retryable: true,
    })
    expect(calls).toHaveLength(3)
  })

  it('classifies an unreachable endpoint as CONNECTION', async () => {
    const { client } = clientWith([new TypeError('fetch failed')], { maxRetries: 0 })
    await expect(client.evaluate({ state: 'x', questions: QUESTIONS })).rejects.toMatchObject({
      code: 'CONNECTION',
      retryable: true,
    })
  })

  it('classifies a 200 with a non-JSON body as INVALID_RESPONSE', async () => {
    const { client } = clientWith([new Response('<html>proxy</html>', { status: 200 })])
    await expect(client.evaluate({ state: 'x', questions: QUESTIONS })).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
      retryable: false,
    })
  })

  it('classifies a per-attempt timeout as TIMEOUT', async () => {
    const hanging = (): Promise<Response> => new Promise((_resolve, reject) => {
      setTimeout(() => reject(new DOMException('aborted', 'AbortError')), 5)
    })
    const { client } = clientWith([hanging], { timeoutMs: 1000, budgetMs: 2000, maxRetries: 0 })
    await expect(client.evaluate({ state: 'x', questions: QUESTIONS })).rejects.toMatchObject({ code: 'TIMEOUT' })
  })

  it('classifies caller cancellation as ABORTED and does not retry it', async () => {
    const controller = new AbortController()
    controller.abort()
    const { client, calls } = clientWith([new Error('should not be reached')], { maxRetries: 3 })
    await expect(client.evaluate({ state: 'x', questions: QUESTIONS, signal: controller.signal }))
      .rejects.toMatchObject({ code: 'ABORTED' })
    expect(calls).toHaveLength(0)
  })

  it('aborts in-flight work when the caller cancels', async () => {
    const controller = new AbortController()
    let entered = false
    const pending = (_url: FetchInput, init?: RequestInit): Promise<Response> => new Promise((_resolve, reject) => {
      entered = true
      const rejectAborted = (): void => reject(new DOMException('aborted', 'AbortError'))
      if (init?.signal?.aborted === true) {
        rejectAborted()
        return
      }
      init?.signal?.addEventListener('abort', rejectAborted, { once: true })
    })
    const { client } = clientWith([], {
      fetch: pending as unknown as typeof globalThis.fetch,
      maxRetries: 0,
    })
    const evaluation = client.evaluate({ state: 'x', questions: QUESTIONS, signal: controller.signal })
    // Cancel only once the request is genuinely in flight.
    while (!entered) await new Promise(resolve => setTimeout(resolve, 1))
    controller.abort()
    await expect(evaluation).rejects.toMatchObject({ code: 'ABORTED' })
  })

  it('honours a whole-call budget shorter than the retry chain', async () => {
    const { client } = clientWith([json({ error: 'slow down' }, 429)], { maxRetries: 5, budgetMs: 250 })
    await expect(client.evaluate({ state: 'x', questions: QUESTIONS })).rejects.toMatchObject({ code: 'TIMEOUT' })
  })

  it('logs a warning per retry instead of staying silent', async () => {
    const warn = vi.fn()
    const { client } = clientWith([json({ error: 'slow down' }, 429), json(OK_BODY)], {
      maxRetries: 1,
      logger: { warn },
    })
    await client.evaluate({ state: 'x', questions: QUESTIONS })
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]?.[0]).toMatch(/will retry/)
  })
})
