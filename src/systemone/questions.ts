/**
 * Local validation of questions before anything leaves the process.
 *
 * The service documents three hard limits — at most 255 Choice options, 2–10
 * Score levels, and a 32k-token budget for `state` plus the longest question —
 * and rejects a malformed question with `422`. Failing here instead keeps the
 * caller's own error message and avoids paying for a round trip.
 *
 * @module dsh-jev/systemone/questions
 */

import { JevError } from './errors.js'
import type { ChoiceQuestion, NoulQuestion, Question, Questions, ScoreQuestion } from './types.js'

/** Documented and locally enforced bounds. */
export interface QuestionLimits {
  /** Maximum number of questions in one call. */
  maxQuestions: number
  /** Maximum Choice options per question (service limit: 255). */
  maxChoiceOptions: number
  /** Minimum Score levels per question (service limit: 2). */
  minScoreLevels: number
  /** Maximum Score levels per question (service limit: 10). */
  maxScoreLevels: number
  /** Maximum characters of one instruction string. */
  maxInstructionChars: number
  /** Maximum characters of the serialized `state`. */
  maxStateChars: number
}

/** Limits matching the documented service contract. */
export const DEFAULT_QUESTION_LIMITS: Readonly<QuestionLimits> = Object.freeze({
  maxQuestions: 64,
  maxChoiceOptions: 255,
  minScoreLevels: 2,
  maxScoreLevels: 10,
  maxInstructionChars: 8000,
  maxStateChars: 96_000,
})

/** Throw an `INVALID_QUESTION` carrying every violation found. */
function reject(violations: readonly string[]): never {
  throw new JevError('INVALID_QUESTION', `invalid jev request: ${violations.join('; ')}`, {
    detail: { violations },
  })
}

/** Whether an instruction value is one of the three accepted shapes and non-empty. */
function instructionViolation(value: unknown, label: string, limits: QuestionLimits): string | undefined {
  if (typeof value === 'string') {
    if (value.trim().length === 0) return `${label} is an empty string`
    if (value.length > limits.maxInstructionChars) {
      return `${label} is ${value.length} characters (limit ${limits.maxInstructionChars})`
    }
    return undefined
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return `${label} is an empty array`
    return undefined
  }
  if (typeof value === 'object' && value !== null) {
    if (Object.keys(value).length === 0) return `${label} is an empty object`
    return undefined
  }
  return `${label} must be a string, object, or array`
}

/** Validate one question, appending every violation to `violations`. */
function checkQuestion(id: string, question: Question, limits: QuestionLimits, violations: string[]): void {
  const base = `questions.${id}`
  const instructions = instructionViolation(question.instructions, `${base}.instructions`, limits)
  if (instructions !== undefined) violations.push(instructions)

  switch (question.type) {
    case 'noul': {
      const criteria = question.criteria
      if (criteria === undefined) return
      if (typeof criteria !== 'object' || criteria === null || Array.isArray(criteria)) {
        violations.push(`${base}.criteria must be an object with optional "true"/"false" entries`)
        return
      }
      for (const key of ['true', 'false'] as const) {
        const value = criteria[key]
        if (value === undefined) continue
        const problem = instructionViolation(value, `${base}.criteria.${key}`, limits)
        if (problem !== undefined) violations.push(problem)
      }
      return
    }
    case 'choice': {
      const criteria = question.criteria
      if (typeof criteria !== 'object' || criteria === null || Array.isArray(criteria)) {
        violations.push(`${base}.criteria must be an object mapping each option to a description`)
        return
      }
      const options = Object.keys(criteria)
      if (options.length === 0) {
        violations.push(`${base}.criteria must define at least one option`)
        return
      }
      if (options.length > limits.maxChoiceOptions) {
        violations.push(
          `${base}.criteria has ${options.length} options (service limit ${limits.maxChoiceOptions})`,
        )
      }
      for (const option of options) {
        const value = criteria[option]
        if (value === null || value === undefined) continue
        const problem = instructionViolation(value, `${base}.criteria.${option}`, limits)
        if (problem !== undefined) violations.push(problem)
      }
      return
    }
    case 'score': {
      const criteria = question.criteria
      if (!Array.isArray(criteria)) {
        violations.push(`${base}.criteria must be an ordered array of level descriptions`)
        return
      }
      if (criteria.length < limits.minScoreLevels || criteria.length > limits.maxScoreLevels) {
        violations.push(
          `${base}.criteria has ${criteria.length} levels (service accepts ${limits.minScoreLevels}–${limits.maxScoreLevels})`,
        )
      }
      criteria.forEach((level, index) => {
        const problem = instructionViolation(level, `${base}.criteria[${index}]`, limits)
        if (problem !== undefined) violations.push(problem)
      })
      return
    }
    default: {
      const exhaustive: never = question
      violations.push(`${base}.type is not a System One question type: ${JSON.stringify(exhaustive)}`)
    }
  }
}

/**
 * Validate a question map. Throws `INVALID_QUESTION` listing every violation, so
 * one call reports all problems instead of only the first.
 * @param questions - the question map about to be sent.
 * @param limits - bounds to enforce.
 */
export function validateQuestions(
  questions: Questions,
  limits: QuestionLimits = DEFAULT_QUESTION_LIMITS,
): void {
  const violations: string[] = []
  if (typeof questions !== 'object' || questions === null || Array.isArray(questions)) {
    reject(['questions must be an object mapping ids to questions'])
  }
  const ids = Object.keys(questions)
  if (ids.length === 0) reject(['questions must contain at least one question'])
  if (ids.length > limits.maxQuestions) {
    violations.push(`questions has ${ids.length} entries (limit ${limits.maxQuestions})`)
  }
  for (const id of ids) {
    if (id.trim().length === 0) {
      violations.push('question ids must be non-empty')
      continue
    }
    const question = questions[id]
    if (question === undefined || typeof question !== 'object' || question === null) {
      violations.push(`questions.${id} must be a question object`)
      continue
    }
    checkQuestion(id, question, limits, violations)
  }
  if (violations.length > 0) reject(violations)
}

/**
 * Bound `state` for transport. Structured state is serialized first so the
 * character budget applies to what is actually sent, mirroring the service's
 * "state plus the longest question" accounting.
 * @param state - caller-supplied state.
 * @param limits - bounds to enforce.
 * @returns the state to transmit.
 */
export function boundState(state: unknown, limits: QuestionLimits = DEFAULT_QUESTION_LIMITS): unknown {
  if (state === undefined || state === null) reject(['state is required'])
  const serialized = typeof state === 'string' ? state : JSON.stringify(state)
  if (serialized === undefined) reject(['state is not serializable to JSON'])
  if (serialized.trim().length === 0) reject(['state is empty'])
  if (serialized.length > limits.maxStateChars) {
    reject([`state is ${serialized.length} characters (limit ${limits.maxStateChars})`])
  }
  return state
}

/** Build a Noul question. */
export function noul(instructions: NoulQuestion['instructions'], criteria?: NoulQuestion['criteria']): NoulQuestion {
  return criteria === undefined ? { type: 'noul', instructions } : { type: 'noul', instructions, criteria }
}

/** Build a Choice question from an option-to-description map. */
export function choice(
  instructions: ChoiceQuestion['instructions'],
  criteria: ChoiceQuestion['criteria'],
): ChoiceQuestion {
  return { type: 'choice', instructions, criteria }
}

/** Build a Score question from an ordered level list. */
export function score(instructions: ScoreQuestion['instructions'], criteria: ScoreQuestion['criteria']): ScoreQuestion {
  return { type: 'score', instructions, criteria }
}
