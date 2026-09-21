/**
 * Local validation of questions and state: a malformed request must be rejected
 * before anything leaves the process.
 */

import { describe, expect, it } from 'vitest'
import { JevError } from '../src/systemone/errors.js'
import {
  DEFAULT_QUESTION_LIMITS,
  boundState,
  choice,
  noul,
  score,
  validateQuestions,
} from '../src/systemone/questions.js'

/** Capture the JevError a thunk throws. */
function caught(fn: () => void): JevError {
  try {
    fn()
  } catch (error) {
    if (error instanceof JevError) return error
    throw error
  }
  throw new Error('expected a JevError, but nothing was thrown')
}

describe('validateQuestions', () => {
  it('accepts one question of each type', () => {
    expect(() => validateQuestions({
      urgent: noul('Is this urgent?'),
      team: choice('Which team?', { billing: 'Charges', technical: 'Bugs' }),
      anger: score('How angry?', ['Calm', 'Frustrated', 'Angry']),
    })).not.toThrow()
  })

  it('rejects an empty question map', () => {
    const error = caught(() => validateQuestions({}))
    expect(error.code).toBe('INVALID_QUESTION')
    expect(error.message).toMatch(/at least one question/)
  })

  it('rejects an empty instruction string', () => {
    const error = caught(() => validateQuestions({ q: noul('   ') }))
    expect(error.detail).toMatchObject({ violations: [expect.stringMatching(/empty string/)] })
  })

  it('rejects a Choice above the documented 255-option limit', () => {
    const criteria: Record<string, string> = {}
    for (let index = 0; index < 256; index += 1) criteria[`option-${index}`] = `description ${index}`
    const error = caught(() => validateQuestions({ q: choice('Pick one', criteria) }))
    expect(error.message).toMatch(/256 options \(service limit 255\)/)
  })

  it('accepts exactly 255 options, the documented boundary', () => {
    const criteria: Record<string, string> = {}
    for (let index = 0; index < 255; index += 1) criteria[`option-${index}`] = `description ${index}`
    expect(() => validateQuestions({ q: choice('Pick one', criteria) })).not.toThrow()
  })

  it('rejects a Score with fewer than two or more than ten levels', () => {
    const tooFew = caught(() => validateQuestions({ q: score('Rate', ['Only one']) }))
    expect(tooFew.message).toMatch(/1 levels \(service accepts 2–10\)/)
    const tooMany = caught(() => validateQuestions({
      q: score('Rate', ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11']),
    }))
    expect(tooMany.message).toMatch(/11 levels \(service accepts 2–10\)/)
  })

  it('accepts the documented Score boundaries of 2 and 10 levels', () => {
    expect(() => validateQuestions({ q: score('Rate', ['Low', 'High']) })).not.toThrow()
    expect(() => validateQuestions({
      q: score('Rate', ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10']),
    })).not.toThrow()
  })

  it('rejects a Choice with no options', () => {
    const error = caught(() => validateQuestions({ q: choice('Which?', {}) }))
    expect(error.message).toMatch(/at least one option/)
  })

  it('reports every violation at once instead of only the first', () => {
    const error = caught(() => validateQuestions({
      a: noul(''),
      b: score('Rate', ['one']),
      c: choice('Which?', {}),
    }))
    const violations = (error.detail as { violations: string[] }).violations
    expect(violations.length).toBeGreaterThanOrEqual(3)
    expect(violations.join('\n')).toMatch(/questions\.a/)
    expect(violations.join('\n')).toMatch(/questions\.b/)
    expect(violations.join('\n')).toMatch(/questions\.c/)
  })

  it('rejects more questions than the configured limit', () => {
    const questions: Record<string, ReturnType<typeof noul>> = {}
    for (let index = 0; index < 3; index += 1) questions[`q${index}`] = noul('Is it so?')
    const error = caught(() => validateQuestions(questions, { ...DEFAULT_QUESTION_LIMITS, maxQuestions: 2 }))
    expect(error.message).toMatch(/3 entries \(limit 2\)/)
  })

  it('rejects a criteria value that is not a supported instruction shape', () => {
    const error = caught(() => validateQuestions({
      q: choice('Which?', { billing: 42 as unknown as string }),
    }))
    expect(error.message).toMatch(/must be a string, object, or array/)
  })
})

describe('boundState', () => {
  it('accepts text and structured state', () => {
    expect(boundState('hello')).toBe('hello')
    expect(boundState({ a: 1 })).toEqual({ a: 1 })
  })

  it('rejects missing, empty, and oversized state', () => {
    expect(caught(() => boundState(undefined)).message).toMatch(/state is required/)
    expect(caught(() => boundState('   ')).message).toMatch(/state is empty/)
    const error = caught(() => boundState('x'.repeat(20), { ...DEFAULT_QUESTION_LIMITS, maxStateChars: 10 }))
    expect(error.message).toMatch(/state is 20 characters \(limit 10\)/)
  })

  it('measures structured state as its serialized size', () => {
    const error = caught(() => boundState({ key: 'x'.repeat(50) }, { ...DEFAULT_QUESTION_LIMITS, maxStateChars: 20 }))
    expect(error.message).toMatch(/state is \d+ characters \(limit 20\)/)
  })
})
