/**
 * End-to-end test through the *real* DSH tool registry.
 *
 * The plugin is mounted on a real Cordis context with the real `ToolRuntime`,
 * `jev_ask` is registered, and the call goes through the registry's own
 * argument validation, output-schema validation, and content rendering. Only
 * `fetch` is stubbed, so no test touches the network.
 */

import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as jev from '../src/index.js'
import type { Config } from '../src/config.js'

/** The input type the global fetch accepts, without depending on DOM lib types. */
type FetchInput = Parameters<typeof globalThis.fetch>[0]

/** One recorded request to the stubbed fetch. */
interface Recorded {
  url: string
  body: Record<string, unknown>
}

const contexts: Context[] = []
let calls: Recorded[] = []

/** Mount a fresh harness with the plugin installed. */
async function mount(config: Config = { apiKey: 'test-key' }): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(jev, config)
  contexts.push(ctx)
  return ctx
}

/** Install a fetch stub answering every call with `body`. */
function stubFetch(body: unknown): void {
  vi.stubGlobal('fetch', (async (input: FetchInput, init?: RequestInit) => {
    calls.push({
      url: String(input),
      body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
    })
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof globalThis.fetch)
}

/** Call `jev_ask` through the registry. */
async function ask(ctx: Context, args: unknown) {
  return ctx.tools.execute({
    callId: ToolCallId('c1'),
    name: 'jev_ask',
    arguments: args,
    signal: new AbortController().signal,
  })
}

/** The model-facing text of a result. */
function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.map(block => block.text ?? '').join('\n')
}

beforeEach(() => {
  calls = []
})

afterEach(async () => {
  vi.unstubAllGlobals()
  while (contexts.length > 0) {
    const ctx = contexts.pop()
    if (ctx !== undefined) await ctx.fiber.dispose()
  }
})

describe('jev_ask through the real tool registry', () => {
  it('registers the tool and evaluates a mixed question set', async () => {
    stubFetch({
      model: 'typesafe/jev-1.13-20260917',
      answers: {
        urgent: { type: 'noul', noul: 0.95 },
        team: {
          type: 'choice',
          choice: 'billing',
          probabilities: { billing: 0.88, technical: 0.12 },
          confidence: 0.81,
        },
        anger: {
          type: 'score',
          score: 1.05,
          legend: { 0: 'Calm', 1: 'Frustrated', 2: 'Angry' },
          probabilities: { 0: 0, 1: 0.95, 2: 0.05 },
          confidence: 0.92,
        },
      },
      usage: { input_tokens: 318, output_tokens: 34, cost: 0.0000134 },
    })
    const ctx = await mount()
    expect(ctx.tools.get('jev_ask')).toBeDefined()

    const result = await ask(ctx, {
      state: 'I was charged twice for my subscription.',
      questions: [
        { id: 'urgent', type: 'noul', instructions: 'Is the customer asking for money back?' },
        { id: 'team', type: 'choice', instructions: 'Which team should handle this?', options: ['billing', 'technical'] },
        { id: 'anger', type: 'score', instructions: 'How frustrated is the customer?', levels: ['Calm', 'Frustrated', 'Angry'] },
      ],
    })

    expect(result.isError).toBe(false)
    if (result.isError) return

    // The registry validated the canonical value against the declared output
    // schema before this point; a conforming value proves the schema matches.
    const value = result.value as {
      model: string
      answers: Array<Record<string, unknown>>
      usage?: Record<string, number>
    }
    expect(value.model).toBe('typesafe/jev-1.13-20260917')
    expect(value.answers).toEqual([
      { id: 'urgent', type: 'noul', value: 0.95 },
      { id: 'team', type: 'choice', value: 'billing', confidence: 0.81, probabilities: { billing: 0.88, technical: 0.12 } },
      {
        id: 'anger',
        type: 'score',
        value: 1.05,
        confidence: 0.92,
        probabilities: { 0: 0, 1: 0.95, 2: 0.05 },
        legend: { 0: 'Calm', 1: 'Frustrated', 2: 'Angry' },
      },
    ])
    expect(value.usage).toMatchObject({ input_tokens: 318, cost: 0.0000134 })
    expect(textOf(result)).toMatch(/Jev \(typesafe\/jev-1\.13-20260917\) answered 3 question\(s\)/)
  })

  it('translates the model-facing question list into the documented API shapes', async () => {
    stubFetch({ model: 'm', answers: { team: { type: 'choice', choice: 'a', probabilities: { a: 1, b: 0 }, confidence: 1 } } })
    const ctx = await mount()
    await ask(ctx, {
      state: 'text',
      questions: [
        { id: 'team', type: 'choice', instructions: 'Which?', options: ['a', 'b'] },
      ],
    })
    expect(calls[0]?.url).toBe('https://openrouter.ai/api/v1/systemone')
    expect(calls[0]?.body).toMatchObject({
      model: 'jev-1.13',
      state: 'text',
      questions: {
        team: { type: 'choice', instructions: 'Which?', criteria: { a: 'a', b: 'b' } },
      },
    })
  })

  it('sends structured state parsed from state_json, which wins over state', async () => {
    stubFetch({ model: 'm', answers: { q: { type: 'noul', noul: 0.5 } } })
    const ctx = await mount()
    await ask(ctx, {
      state: 'ignored',
      state_json: JSON.stringify({ record: { id: 7 } }),
      questions: [{ id: 'q', type: 'noul', instructions: 'Is it so?' }],
    })
    expect(calls[0]?.body.state).toEqual({ record: { id: 7 } })
  })

  it('honours the typesafe backend and its default model', async () => {
    stubFetch({ model: 'jev-1.13.0', answers: { q: { type: 'noul', noul: 0.5 } } })
    const ctx = await mount({ apiKey: 'test-key', backend: 'typesafe' })
    await ask(ctx, { state: 'x', questions: [{ id: 'q', type: 'noul', instructions: 'Is it so?' }] })
    expect(calls[0]?.url).toBe('https://api.typesafe.ai/v1/systemone')
    expect(calls[0]?.body.model).toBe('jev-latest')
  })

  it('rejects a malformed question with an actionable message and no request', async () => {
    stubFetch({ model: 'm', answers: {} })
    const ctx = await mount()
    const result = await ask(ctx, {
      state: 'x',
      questions: [{ id: 'q', type: 'choice', instructions: 'Which?', options: [] }],
    })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toMatch(/needs a non-empty "options" array/)
    expect(calls).toHaveLength(0)
  })

  it('rejects duplicate question ids', async () => {
    stubFetch({ model: 'm', answers: {} })
    const ctx = await mount()
    const result = await ask(ctx, {
      state: 'x',
      questions: [
        { id: 'q', type: 'noul', instructions: 'One?' },
        { id: 'q', type: 'noul', instructions: 'Two?' },
      ],
    })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toMatch(/duplicated/)
  })

  it('rejects a score question with too few levels', async () => {
    stubFetch({ model: 'm', answers: {} })
    const ctx = await mount()
    const result = await ask(ctx, {
      state: 'x',
      questions: [{ id: 'q', type: 'score', instructions: 'Rate', levels: ['only'] }],
    })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toMatch(/at least 2 "levels"/)
  })

  it('rejects a call with neither state nor state_json', async () => {
    stubFetch({ model: 'm', answers: {} })
    const ctx = await mount()
    const result = await ask(ctx, { questions: [{ id: 'q', type: 'noul', instructions: 'Is it so?' }] })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toMatch(/provide either "state"/)
  })

  it('reports an unconfigured key as an actionable tool error rather than failing the load', async () => {
    stubFetch({ model: 'm', answers: {} })
    // No literal key, and the credential reference points at an unset variable.
    const ctx = await mount({ apiKeyEnv: 'DSH_JEV_UNSET_KEY_FOR_TEST' })
    const result = await ask(ctx, { state: 'x', questions: [{ id: 'q', type: 'noul', instructions: 'Is it so?' }] })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toMatch(/no Jev API key is configured/)
  })

  it('reports a service contract violation to the model instead of returning partial data', async () => {
    stubFetch({ model: 'm', answers: { q: { type: 'noul', noul: 9 } } })
    const ctx = await mount()
    const result = await ask(ctx, { state: 'x', questions: [{ id: 'q', type: 'noul', instructions: 'Is it so?' }] })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toMatch(/INVALID_RESPONSE/)
  })

  it('surfaces a service 401 as a classified error', async () => {
    vi.stubGlobal('fetch', (async () => new Response(JSON.stringify({ error: 'invalid api key' }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof globalThis.fetch)
    const ctx = await mount()
    const result = await ask(ctx, { state: 'x', questions: [{ id: 'q', type: 'noul', instructions: 'Is it so?' }] })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toMatch(/UNAUTHORIZED: invalid api key/)
  })

  it('enforces the configured state character limit', async () => {
    stubFetch({ model: 'm', answers: {} })
    const ctx = await mount({ apiKey: 'test-key', maxStateChars: 10 })
    const result = await ask(ctx, {
      state: 'x'.repeat(50),
      questions: [{ id: 'q', type: 'noul', instructions: 'Is it so?' }],
    })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toMatch(/state is 50 characters \(limit 10\)/)
  })
})
