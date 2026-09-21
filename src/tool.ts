/**
 * The `jev_ask` tool: typed judgments instead of prose.
 *
 * The model supplies a state and a list of typed questions; the answers come
 * back as validated values (probabilities, a chosen option, a rubric score)
 * that code can branch on. Nothing here interprets the answers — this tool
 * exposes the primitive, it does not act on it.
 *
 * @module dsh-jev/tool
 */

import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { ResolvedSettings } from './config.js'
import { SystemOneClient, type JevLogger } from './systemone/client.js'
import { JevError, describeThrown } from './systemone/errors.js'
import { choice, noul, score } from './systemone/questions.js'
import type { Answer, Question, Questions } from './systemone/types.js'

/** Tool name as the model sees it. */
export const JEV_ASK_TOOL_NAME = 'jev_ask'

/** One question as the model supplies it. */
interface AskQuestion {
  id: string
  type: 'noul' | 'choice' | 'score'
  instructions: string
  options?: string[]
  levels?: string[]
  true_meaning?: string
  false_meaning?: string
}

/** Arguments of one `jev_ask` call. */
interface AskArgs {
  state?: string
  state_json?: string
  questions: AskQuestion[]
}

/** One answer in the canonical tool value. */
interface CanonicalAnswer {
  id: string
  type: 'noul' | 'choice' | 'score'
  value: number | string
  confidence?: number
  probabilities?: Record<string, number>
  legend?: Record<string, string>
}

/** The canonical tool value. */
interface CanonicalReply {
  model: string
  answers: CanonicalAnswer[]
  usage?: { input_tokens?: number; output_tokens?: number; cost?: number }
}

/** Dependencies the tool needs from the plugin. */
export interface JevAskToolDeps {
  /** Reads the currently authoritative settings. */
  settings: () => ResolvedSettings
  /** Resolves the API key for one call. */
  resolveApiKey: () => Promise<string | undefined>
  /** Optional harness logger. */
  logger?: JevLogger
}

const DESCRIPTION =
  'Ask TypeSafe Jev (a System One model) up to a few dozen typed questions about a body of text or structured state, and get '
  + 'structured answers back instead of prose. Use it when you need a judgment your own code can branch on: is this true '
  + '(noul), which of these options fits (choice), or how does this rate on a rubric (score). '
  + 'Ask atomic questions — one specific thing each — rather than one broad question that weighs several factors; ask the '
  + 'factors separately and combine them yourself. All questions in one call are evaluated in parallel and independently '
  + 'against the same state, so batching many questions into one call is cheap and does not make individual answers less '
  + 'reliable. Each answer is a probability: noul returns a number in [0,1] with no confidence; choice returns the chosen '
  + 'option plus a full probability distribution and a confidence; score returns a probability-weighted value on your rubric '
  + '(which can land between levels) plus a distribution and a confidence. Threshold the probabilities yourself; do not treat '
  + 'a choice answer as certain because it was the highest option. A choice question needs "options" (2 or more, at most 255); '
  + 'a score question needs "levels" (2 to 10, lowest first); noul may optionally describe what yes and no mean via '
  + '"true_meaning"/"false_meaning". Keep the state focused on what the questions need: everything you send is evaluated.'

/** Build the API question map from the model-facing argument list. */
function buildQuestions(asked: readonly AskQuestion[]): Questions {
  const questions: Questions = {}
  const problems: string[] = []
  for (const item of asked) {
    if (item.id.trim().length === 0) {
      problems.push('every question needs a non-empty id')
      continue
    }
    if (Object.hasOwn(questions, item.id)) {
      problems.push(`question id "${item.id}" is duplicated`)
      continue
    }
    let built: Question
    switch (item.type) {
      case 'noul': {
        const criteria = item.true_meaning !== undefined || item.false_meaning !== undefined
          ? {
            ...item.true_meaning === undefined ? {} : { true: item.true_meaning },
            ...item.false_meaning === undefined ? {} : { false: item.false_meaning },
          }
          : undefined
        built = noul(item.instructions, criteria)
        break
      }
      case 'choice': {
        const options = item.options ?? []
        if (options.length === 0) {
          problems.push(`choice question "${item.id}" needs a non-empty "options" array`)
          continue
        }
        const duplicates = options.filter((option, index) => options.indexOf(option) !== index)
        if (duplicates.length > 0) {
          problems.push(`choice question "${item.id}" repeats option(s): ${[...new Set(duplicates)].join(', ')}`)
          continue
        }
        // A rubric per option is what makes the choice reliable; the option label
        // is the description when the caller supplied nothing richer.
        const criteria: Record<string, string> = {}
        for (const option of options) criteria[option] = option
        built = choice(item.instructions, criteria)
        break
      }
      case 'score': {
        const levels = item.levels ?? []
        if (levels.length < 2) {
          problems.push(`score question "${item.id}" needs at least 2 "levels" (got ${levels.length})`)
          continue
        }
        built = score(item.instructions, [...levels])
        break
      }
      default: {
        problems.push(`question "${item.id}" has unknown type ${JSON.stringify((item as { type: unknown }).type)}`)
        continue
      }
    }
    questions[item.id] = built
  }
  if (problems.length > 0) {
    throw new JevError('INVALID_QUESTION', `invalid jev_ask questions: ${problems.join('; ')}`, {
      detail: { violations: problems },
    })
  }
  return questions
}

/** Resolve the state to evaluate, preferring structured JSON when supplied. */
function resolveState(args: AskArgs): unknown {
  if (args.state_json !== undefined && args.state_json.trim().length > 0) {
    try {
      return JSON.parse(args.state_json) as unknown
    } catch (error) {
      throw new JevError('INVALID_QUESTION', 'state_json is not valid JSON', { cause: error })
    }
  }
  if (args.state !== undefined && args.state.trim().length > 0) return args.state
  throw new JevError('INVALID_QUESTION', 'provide either "state" (text) or "state_json" (structured JSON text)')
}

/** Project a validated answer into the canonical, schema-checked shape. */
function toCanonical(id: string, answer: Answer): CanonicalAnswer {
  switch (answer.type) {
    case 'noul':
      // No confidence by contract: a Noul answer is already a probability.
      return { id, type: 'noul', value: answer.noul }
    case 'choice':
      return {
        id,
        type: 'choice',
        value: answer.choice,
        confidence: answer.confidence,
        probabilities: answer.probabilities,
      }
    case 'score':
      return {
        id,
        type: 'score',
        value: answer.score,
        confidence: answer.confidence,
        probabilities: answer.probabilities,
        legend: answer.legend,
      }
  }
}

/** Render a compact, readable summary followed by the exact structured value. */
function formatReply(value: CanonicalReply): string {
  const lines = value.answers.map((answer) => {
    switch (answer.type) {
      case 'noul':
        return `- ${answer.id}: noul ${answer.value}`
      case 'choice': {
        const distribution = Object.entries(answer.probabilities ?? {})
          .map(([option, probability]) => `${option} ${probability}`)
          .join(', ')
        return `- ${answer.id}: choice "${String(answer.value)}" (confidence ${answer.confidence}; ${distribution})`
      }
      case 'score': {
        const distribution = Object.entries(answer.probabilities ?? {})
          .map(([level, probability]) => `${answer.legend?.[level] ?? level} ${probability}`)
          .join(', ')
        return `- ${answer.id}: score ${answer.value} (confidence ${answer.confidence}; ${distribution})`
      }
    }
  })
  const usage = value.usage === undefined
    ? ''
    : `\nusage: ${value.usage.input_tokens ?? '?'} in / ${value.usage.output_tokens ?? '?'} out${value.usage.cost === undefined ? '' : `, $${value.usage.cost}`}`
  return `Jev (${value.model}) answered ${value.answers.length} question(s):\n${lines.join('\n')}${usage}\n\n${JSON.stringify(value)}`
}

/**
 * Build the `jev_ask` tool definition.
 * @param deps - settings reader, key resolver, and logger.
 * @returns a registry-ready tool definition.
 */
export function createJevAskTool(deps: JevAskToolDeps): ToolDefinition {
  /** One client per call, so every settings change takes effect immediately. */
  const clientFor = (settings: ResolvedSettings): SystemOneClient => new SystemOneClient({
    baseURL: settings.baseURL,
    resolveApiKey: deps.resolveApiKey,
    resolveModel: () => settings.model,
    timeoutMs: settings.timeoutMs,
    budgetMs: settings.budgetMs,
    maxRetries: settings.maxRetries,
    limits: settings.limits,
    appName: settings.appName,
    ...settings.appUrl === undefined ? {} : { appUrl: settings.appUrl },
    ...deps.logger === undefined ? {} : { logger: deps.logger },
  })

  return defineTool({
    name: JEV_ASK_TOOL_NAME,
    description: DESCRIPTION,
    parameters: {
      state: {
        type: 'string',
        description: 'The text to evaluate. Everything here is sent to the model, so include what the questions need and nothing else. Omit when using state_json.',
      },
      state_json: {
        type: 'string',
        description: 'Structured state as a JSON string (object or array), for records, chat logs, or application state. Takes precedence over state when both are given.',
      },
      questions: {
        type: 'array',
        required: true,
        description: 'The questions to evaluate, each with a unique id.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string', required: true, description: 'Stable id for this question; echoed back in the answer.' },
            type: {
              type: 'string',
              required: true,
              enum: ['noul', 'choice', 'score'],
              description: 'noul = yes/no probability; choice = pick one option; score = rate on a rubric.',
            },
            instructions: { type: 'string', required: true, description: 'One specific, atomic question in plain language.' },
            options: {
              type: 'array',
              items: { type: 'string' },
              description: 'Required for type "choice": the options to choose between.',
            },
            levels: {
              type: 'array',
              items: { type: 'string' },
              description: 'Required for type "score": 2–10 ordered levels, lowest first.',
            },
            true_meaning: { type: 'string', description: 'Optional for "noul": what a yes (near 1) means.' },
            false_meaning: { type: 'string', description: 'Optional for "noul": what a no (near 0) means.' },
          },
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          model: { type: 'string', required: true, description: 'The model that produced the answers.' },
          answers: {
            type: 'array',
            required: true,
            description: 'One answer per requested question, in the same order.',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                type: { type: 'string', required: true, enum: ['noul', 'choice', 'score'] },
                value: {
                  required: true,
                  description: 'noul: probability in [0,1]. choice: the chosen option. score: the rubric value.',
                  oneOf: [{ type: 'number' }, { type: 'string' }],
                },
                confidence: { type: 'number', description: 'Present for choice and score only.' },
                probabilities: {
                  type: 'object',
                  additionalProperties: true,
                  description: 'Full distribution over options (choice) or rubric levels (score).',
                },
                legend: {
                  type: 'object',
                  additionalProperties: true,
                  description: 'Score only: rubric level index mapped to its description.',
                },
              },
            },
          },
          usage: {
            type: 'object',
            additionalProperties: false,
            properties: {
              input_tokens: { type: 'number' },
              output_tokens: { type: 'number' },
              cost: { type: 'number', description: 'Reported by the OpenRouter backend only.' },
            },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: formatReply(value as CanonicalReply) }],
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      const settings = deps.settings()
      const state = resolveState(args as AskArgs)
      const questions = buildQuestions((args as AskArgs).questions)
      try {
        const reply = await clientFor(settings).evaluate({ state, questions })
        const answers = Object.keys(questions).map(id => {
          const answer = reply.answers[id]
          if (answer === undefined) {
            // validateReply guarantees presence; this is an internal invariant.
            throw new JevError('INVALID_RESPONSE', `the service omitted an answer for "${id}"`)
          }
          return toCanonical(id, answer)
        })
        if (settings.logRequests) {
          deps.logger?.info?.('jev_ask evaluated', {
            backend: settings.backend,
            model: reply.model,
            questions: answers.length,
            inputTokens: reply.usage?.input_tokens,
            outputTokens: reply.usage?.output_tokens,
            cost: reply.usage?.cost,
          })
        }
        return {
          model: reply.model,
          answers,
          ...reply.usage === undefined ? {} : { usage: reply.usage },
        } satisfies CanonicalReply
      } catch (error) {
        // Surface a classified, actionable message to the model rather than a
        // bare stack: the model can then tell the user what to configure.
        if (error instanceof JevError) {
          throw new Error(`[jev] ${error.code}: ${error.message}`)
        }
        throw new Error(`[jev] ${describeThrown(error)}`)
      }
    },
  })
}
