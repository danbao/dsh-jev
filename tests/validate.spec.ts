/**
 * Boundary validation of the service reply.
 *
 * The point of these tests is that a malformed judgment fails loudly rather
 * than being half-read, and that no `confidence` is ever invented for a Noul.
 */

import { describe, expect, it } from 'vitest'
import { JevError } from '../src/systemone/errors.js'
import { choice, noul, score } from '../src/systemone/questions.js'
import { validateReply } from '../src/systemone/validate.js'

const questions = {
  urgent: noul('Is this urgent?'),
  team: choice('Which team?', { billing: 'Charges', technical: 'Bugs' }),
  anger: score('How angry?', ['Calm', 'Frustrated', 'Angry']),
}

/** Capture the JevError a thunk throws. */
function caught(fn: () => unknown): JevError {
  try {
    fn()
  } catch (error) {
    if (error instanceof JevError) return error
    throw error
  }
  throw new Error('expected a JevError, but nothing was thrown')
}

/** A fully valid reply, which individual tests then corrupt. */
function validReply(): Record<string, unknown> {
  return {
    model: 'jev-1.13.0',
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
    usage: { input_tokens: 318, output_tokens: 34 },
  }
}

describe('validateReply', () => {
  it('accepts the documented example response', () => {
    const reply = validateReply(validReply(), questions)
    expect(reply.model).toBe('jev-1.13.0')
    expect(reply.answers.urgent).toEqual({ type: 'noul', noul: 0.95 })
    expect(reply.answers.team).toMatchObject({ type: 'choice', choice: 'billing', confidence: 0.81 })
    expect(reply.answers.anger).toMatchObject({ type: 'score', confidence: 0.92 })
    expect(reply.usage).toEqual({ input_tokens: 318, output_tokens: 34 })
  })

  it('drops a confidence the service invents for a Noul answer', () => {
    const raw = validReply()
    ;(raw.answers as Record<string, unknown>).urgent = { type: 'noul', noul: 0.4, confidence: 0.99 }
    const reply = validateReply(raw, questions)
    expect(reply.answers.urgent).toEqual({ type: 'noul', noul: 0.4 })
    expect('confidence' in (reply.answers.urgent as object)).toBe(false)
  })

  it('passes through OpenRouter-only fields', () => {
    const reply = validateReply(
      { ...validReply(), id: 'gen-123', provider: 'TypeSafe', usage: { input_tokens: 1, output_tokens: 2, cost: 0.00003 } },
      questions,
    )
    expect(reply.id).toBe('gen-123')
    expect(reply.provider).toBe('TypeSafe')
    expect(reply.usage?.cost).toBe(0.00003)
  })

  it('rejects a missing answer', () => {
    const raw = validReply()
    delete (raw.answers as Record<string, unknown>).team
    const error = caught(() => validateReply(raw, questions))
    expect(error.code).toBe('INVALID_RESPONSE')
    expect(error.message).toMatch(/answers\.team is missing/)
  })

  it('rejects an answer that was never requested', () => {
    const raw = validReply()
    ;(raw.answers as Record<string, unknown>).ghost = { type: 'noul', noul: 0.5 }
    expect(caught(() => validateReply(raw, questions)).message).toMatch(/answers\.ghost was not requested/)
  })

  it('rejects a Choice naming an option that was never offered', () => {
    const raw = validReply()
    ;(raw.answers as Record<string, unknown>).team = {
      type: 'choice', choice: 'sales', probabilities: { billing: 0, technical: 1 }, confidence: 1,
    }
    expect(caught(() => validateReply(raw, questions)).message).toMatch(/not one of the offered options/)
  })

  it('rejects a distribution that does not sum to one', () => {
    const raw = validReply()
    ;(raw.answers as Record<string, unknown>).team = {
      type: 'choice', choice: 'billing', probabilities: { billing: 0.2, technical: 0.2 }, confidence: 0.5,
    }
    expect(caught(() => validateReply(raw, questions)).message).toMatch(/sums to 0\.4000, not 1/)
  })

  it('accepts a distribution that only drifts by float rounding', () => {
    const raw = validReply()
    ;(raw.answers as Record<string, unknown>).team = {
      type: 'choice', choice: 'billing', probabilities: { billing: 0.333, technical: 0.667 }, confidence: 0.5,
    }
    expect(() => validateReply(raw, questions)).not.toThrow()
  })

  it('treats an omitted zero-probability option as zero rather than failing', () => {
    const raw = validReply()
    ;(raw.answers as Record<string, unknown>).team = {
      type: 'choice', choice: 'billing', probabilities: { billing: 1 }, confidence: 1,
    }
    const reply = validateReply(raw, questions)
    expect(reply.answers.team).toMatchObject({ probabilities: { billing: 1, technical: 0 } })
  })

  it('rejects an answer whose type does not match its question', () => {
    const raw = validReply()
    ;(raw.answers as Record<string, unknown>).urgent = { type: 'noul', noul: 0.5 }
    ;(raw.answers as Record<string, unknown>).team = { type: 'noul', noul: 0.5 }
    expect(caught(() => validateReply(raw, questions)).message).toMatch(/answers\.team\.type is "noul", expected "choice"/)
  })

  it('rejects an out-of-range probability and a missing confidence', () => {
    const outOfRange = validReply()
    ;(outOfRange.answers as Record<string, unknown>).urgent = { type: 'noul', noul: 1.4 }
    expect(caught(() => validateReply(outOfRange, questions)).message).toMatch(/must be a probability in \[0,1\]/)

    const noConfidence = validReply()
    ;(noConfidence.answers as Record<string, unknown>).team = {
      type: 'choice', choice: 'billing', probabilities: { billing: 1, technical: 0 },
    }
    expect(caught(() => validateReply(noConfidence, questions)).message).toMatch(/confidence must be a number in \[0,1\]/)
  })

  it('rejects a Score outside the rubric', () => {
    const raw = validReply()
    ;(raw.answers as Record<string, unknown>).anger = {
      type: 'score', score: 7, legend: {}, probabilities: { 0: 0, 1: 1, 2: 0 }, confidence: 1,
    }
    expect(caught(() => validateReply(raw, questions)).message).toMatch(/score must be within \[0,2\]/)
  })

  it('rejects a probability keyed outside the rubric levels', () => {
    const raw = validReply()
    ;(raw.answers as Record<string, unknown>).anger = {
      type: 'score', score: 1, legend: {}, probabilities: { 0: 0, 1: 1, 2: 0, 9: 0 }, confidence: 1,
    }
    expect(caught(() => validateReply(raw, questions)).message).toMatch(/unknown key "9"/)
  })

  it('falls back to the caller level text when the service legend is missing or thin', () => {
    const raw = validReply()
    ;(raw.answers as Record<string, unknown>).anger = {
      type: 'score', score: 1, probabilities: { 0: 0, 1: 1, 2: 0 }, confidence: 1,
    }
    const reply = validateReply(raw, questions)
    expect(reply.answers.anger).toMatchObject({ legend: { 0: 'Calm', 1: 'Frustrated', 2: 'Angry' } })
  })

  it('rejects a reply without a model identifier', () => {
    const raw = validReply()
    delete raw.model
    expect(caught(() => validateReply(raw, questions)).message).toMatch(/model must be a non-empty string/)
  })

  it('rejects a non-object body', () => {
    expect(caught(() => validateReply('nope', questions)).message).toMatch(/non-object body/)
  })

  it('reports every violation rather than only the first', () => {
    const raw = validReply()
    ;(raw.answers as Record<string, unknown>).urgent = { type: 'noul', noul: 5 }
    ;(raw.answers as Record<string, unknown>).team = { type: 'choice', choice: 'nope', probabilities: {}, confidence: 3 }
    const error = caught(() => validateReply(raw, questions))
    const violations = (error.detail as { violations: string[] }).violations
    // One violation from each of two independent answers proves the validator
    // does not stop at the first problem.
    expect(violations).toHaveLength(2)
    expect(violations.join('\n')).toMatch(/answers\.urgent/)
    expect(violations.join('\n')).toMatch(/answers\.team/)
  })

  it('reports both a bad distribution and a bad confidence for one answer', () => {
    const raw = validReply()
    ;(raw.answers as Record<string, unknown>).team = {
      type: 'choice', choice: 'billing', probabilities: { billing: 0.2, technical: 0.2 }, confidence: 7,
    }
    const error = caught(() => validateReply(raw, questions))
    const violations = (error.detail as { violations: string[] }).violations
    expect(violations).toHaveLength(2)
    expect(violations.join('\n')).toMatch(/sums to 0\.4000/)
    expect(violations.join('\n')).toMatch(/confidence must be a number/)
  })
})
