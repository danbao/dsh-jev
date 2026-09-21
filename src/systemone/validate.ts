/**
 * Strict validation of the service reply, at the system boundary.
 *
 * The contract is validated rather than trusted: every requested question must
 * be answered, an answer may not reference an option that was never offered,
 * a distribution must sum to one, and a Noul answer carries **no** `confidence`
 * (the core never invents one). A violation is a hard failure — a model-derived
 * judgment must not be half-read.
 *
 * Tolerance policy: `probabilities` are compared against 1 with a small
 * tolerance because the service rounds floats, and `confidence` values are
 * clamped across tiny float drift. Everything else is exact.
 *
 * @module dsh-jev/systemone/validate
 */

import { JevError } from './errors.js'
import type { Answer, Answers, Questions, ScoreQuestion, Usage } from './types.js'

/** Tolerance for a probability distribution summing to one. */
const DISTRIBUTION_TOLERANCE = 0.01
/** Tolerance for a value that must sit inside a closed numeric range. */
const RANGE_TOLERANCE = 1e-6

/** The validated reply. */
export interface ValidatedReply {
  /** The model id reported by the service. */
  readonly model: string
  /** Answers keyed by the ids the request used. */
  readonly answers: Answers
  /** Token usage, when reported. */
  readonly usage: Usage | undefined
  /** OpenRouter request id, when reported. */
  readonly id: string | undefined
  /** Serving provider label, when reported. */
  readonly provider: string | undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A finite number inside `[min, max]`, tolerating float drift at both ends. */
function inRange(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number'
    && Number.isFinite(value)
    && value >= min - RANGE_TOLERANCE
    && value <= max + RANGE_TOLERANCE
}

/**
 * Read a probability map against the keys the caller offered.
 * Unknown keys are violations; a missing key is read as probability zero, so a
 * valid answer is never rejected merely for omitting a zero-probability option.
 * @returns the completed map, or an error message.
 */
function readProbabilities(
  raw: unknown,
  offered: readonly string[],
  label: string,
  violations: string[],
): Record<string, number> | undefined {
  if (!isRecord(raw)) {
    violations.push(`${label}.probabilities must be an object`)
    return undefined
  }
  const offeredSet = new Set(offered)
  for (const key of Object.keys(raw)) {
    if (!offeredSet.has(key)) {
      violations.push(`${label}.probabilities has unknown key "${key}"`)
    }
  }
  const completed: Record<string, number> = {}
  for (const key of offered) {
    const value = raw[key]
    if (value === undefined) {
      completed[key] = 0
      continue
    }
    if (!inRange(value, 0, 1)) {
      violations.push(`${label}.probabilities["${key}"] must be a probability in [0,1], got ${JSON.stringify(value)}`)
      continue
    }
    completed[key] = value
  }
  const total = Object.values(completed).reduce((sum, value) => sum + value, 0)
  if (Math.abs(total - 1) > DISTRIBUTION_TOLERANCE) {
    violations.push(`${label}.probabilities sums to ${total.toFixed(4)}, not 1`)
  }
  return completed
}

/** Read `confidence`, which Choice and Score answers must carry. */
function readConfidence(raw: unknown, label: string, violations: string[]): number | undefined {
  if (!inRange(raw, 0, 1)) {
    violations.push(`${label}.confidence must be a number in [0,1], got ${JSON.stringify(raw)}`)
    return undefined
  }
  return Math.min(1, Math.max(0, raw))
}

/**
 * Validate one answer against the question that produced it.
 * @returns the normalized answer, or `undefined` when it was invalid.
 */
function readAnswer(
  id: string,
  raw: unknown,
  question: Questions[string],
  violations: string[],
): Answer | undefined {
  const label = `answers.${id}`
  if (!isRecord(raw)) {
    violations.push(`${label} must be an object`)
    return undefined
  }
  if (raw.type !== question.type) {
    violations.push(`${label}.type is ${JSON.stringify(raw.type)}, expected "${question.type}"`)
    return undefined
  }

  switch (question.type) {
    case 'noul': {
      if (!inRange(raw.noul, 0, 1)) {
        violations.push(`${label}.noul must be a probability in [0,1], got ${JSON.stringify(raw.noul)}`)
        return undefined
      }
      // A Noul answer has no confidence by contract; drop any the service sends
      // rather than letting an invented value reach the caller.
      return { type: 'noul', noul: raw.noul }
    }
    case 'choice': {
      const options = Object.keys(question.criteria)
      if (typeof raw.choice !== 'string' || !options.includes(raw.choice)) {
        violations.push(`${label}.choice is ${JSON.stringify(raw.choice)}, not one of the offered options`)
        return undefined
      }
      const probabilities = readProbabilities(raw.probabilities, options, label, violations)
      const confidence = readConfidence(raw.confidence, label, violations)
      if (probabilities === undefined || confidence === undefined) return undefined
      return { type: 'choice', choice: raw.choice, probabilities, confidence }
    }
    case 'score': {
      const levels = question.criteria.length
      if (!inRange(raw.score, 0, levels - 1)) {
        violations.push(`${label}.score must be within [0,${levels - 1}], got ${JSON.stringify(raw.score)}`)
        return undefined
      }
      const levelKeys = Array.from({ length: levels }, (_, index) => String(index))
      const probabilities = readProbabilities(raw.probabilities, levelKeys, label, violations)
      const confidence = readConfidence(raw.confidence, label, violations)
      if (probabilities === undefined || confidence === undefined) return undefined
      // Prefer the service's own legend; fall back to the caller's level text so
      // a level never loses its wording.
      const legend: Record<string, string> = {}
      const rawLegend = isRecord(raw.legend) ? raw.legend : {}
      levelKeys.forEach((key, index) => {
        const serviceText = rawLegend[key]
        legend[key] = typeof serviceText === 'string' && serviceText.length > 0
          ? serviceText
          : describeLevel((question as ScoreQuestion).criteria[index])
      })
      return { type: 'score', score: Math.min(levels - 1, Math.max(0, raw.score)), legend, probabilities, confidence }
    }
    default: {
      violations.push(`${label}: unsupported question type`)
      return undefined
    }
  }
}

/** Reduce a level description to the text a legend can carry. */
function describeLevel(level: unknown): string {
  if (typeof level === 'string') return level
  return JSON.stringify(level) ?? ''
}

/** Read token usage without letting a malformed block fail the whole call. */
function readUsage(raw: unknown): Usage | undefined {
  if (!isRecord(raw)) return undefined
  const usage: { input_tokens?: number; output_tokens?: number; cost?: number } = {}
  if (typeof raw.input_tokens === 'number' && Number.isFinite(raw.input_tokens)) usage.input_tokens = raw.input_tokens
  if (typeof raw.output_tokens === 'number' && Number.isFinite(raw.output_tokens)) usage.output_tokens = raw.output_tokens
  if (typeof raw.cost === 'number' && Number.isFinite(raw.cost)) usage.cost = raw.cost
  return usage
}

/**
 * Validate a raw reply against the questions that were sent.
 * @param raw - the decoded response body.
 * @param questions - the question map used for the request.
 * @returns the validated reply.
 * @throws {JevError} `INVALID_RESPONSE`, listing every violation.
 */
export function validateReply(raw: unknown, questions: Questions): ValidatedReply {
  const violations: string[] = []
  if (!isRecord(raw)) {
    throw new JevError('INVALID_RESPONSE', 'the service returned a non-object body', { detail: { violations: ['body must be an object'] } })
  }
  if (typeof raw.model !== 'string' || raw.model.length === 0) {
    violations.push('model must be a non-empty string')
  }
  const rawAnswers = raw.answers
  if (!isRecord(rawAnswers)) {
    violations.push('answers must be an object keyed by question id')
    throw new JevError('INVALID_RESPONSE', `the service reply did not satisfy the contract: ${violations.join('; ')}`, { detail: { violations } })
  }

  const expected = Object.keys(questions)
  const expectedSet = new Set(expected)
  for (const key of Object.keys(rawAnswers)) {
    if (!expectedSet.has(key)) violations.push(`answers.${key} was not requested`)
  }

  const answers: Answers = {}
  for (const id of expected) {
    const value = rawAnswers[id]
    if (value === undefined) {
      violations.push(`answers.${id} is missing`)
      continue
    }
    const question = questions[id]
    if (question === undefined) continue
    const answer = readAnswer(id, value, question, violations)
    if (answer !== undefined) answers[id] = answer
  }

  if (violations.length > 0) {
    throw new JevError(
      'INVALID_RESPONSE',
      `the service reply did not satisfy the contract: ${violations.join('; ')}`,
      { detail: { violations } },
    )
  }

  return {
    model: raw.model as string,
    answers,
    usage: readUsage(raw.usage),
    id: typeof raw.id === 'string' ? raw.id : undefined,
    provider: typeof raw.provider === 'string' ? raw.provider : undefined,
  }
}
