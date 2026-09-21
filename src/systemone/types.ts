/**
 * Wire types for the TypeSafe System One API (`POST /v1/systemone`).
 *
 * The same shapes are served by TypeSafe directly (`https://api.typesafe.ai`)
 * and by OpenRouter's System One endpoint (`https://openrouter.ai/api`), which
 * implements TypeSafe's request/response contract and adds `id`, `provider`,
 * and `usage.cost`. See:
 * - https://docs.typesafe.ai/api
 * - https://openrouter.ai/docs/guides/community/typesafe-sdk
 *
 * @module dsh-jev/systemone/types
 */

/** Instruction text: a plain question, or a structured question plus the data it references. */
export type Instructions = string | Record<string, unknown> | unknown[]

/** The three System One question types. */
export type QuestionType = 'noul' | 'choice' | 'score'

/** A yes/no question; `noul` returns the probability that the answer is yes. */
export interface NoulQuestion {
  readonly type: 'noul'
  readonly instructions: Instructions
  /** Optional meaning of a yes (`true`) and a no (`false`) answer. */
  readonly criteria?: { readonly true?: Instructions; readonly false?: Instructions }
}

/** Pick one option from a map of option to rubric description (at most 255 options). */
export interface ChoiceQuestion {
  readonly type: 'choice'
  readonly instructions: Instructions
  /** Option to rubric description; `null` when an option needs no extra detail. */
  readonly criteria: Record<string, Instructions | null>
}

/** Rate the state along an ordered rubric of 2–10 levels. */
export interface ScoreQuestion {
  readonly type: 'score'
  readonly instructions: Instructions
  /** Ordered level descriptions, lowest first. */
  readonly criteria: Instructions[]
}

/** One typed question. */
export type Question = NoulQuestion | ChoiceQuestion | ScoreQuestion

/** A map of caller-chosen question id to question. Keys are never sent to the model. */
export type Questions = Record<string, Question>

/** A yes/no answer: a probability, and deliberately no `confidence`. */
export interface NoulAnswer {
  readonly type: 'noul'
  readonly noul: number
}

/** A chosen option with its full probability distribution. */
export interface ChoiceAnswer {
  readonly type: 'choice'
  readonly choice: string
  readonly probabilities: Record<string, number>
  readonly confidence: number
}

/** A probability-weighted score across the rubric levels; may land between levels. */
export interface ScoreAnswer {
  readonly type: 'score'
  readonly score: number
  /** Level index (as a string key) mapped back to its description. */
  readonly legend: Record<string, string>
  readonly probabilities: Record<string, number>
  readonly confidence: number
}

/** One answer, tagged by the type of the question it answers. */
export type Answer = NoulAnswer | ChoiceAnswer | ScoreAnswer

/** Answers keyed by the same ids the request used. */
export type Answers = Record<string, Answer>

/** Token usage. `cost` is OpenRouter-only. */
export interface Usage {
  readonly input_tokens?: number
  readonly output_tokens?: number
  /** Present only on the OpenRouter endpoint. */
  readonly cost?: number
}

/** Request body for `POST /v1/systemone`. */
export interface SystemOneRequest {
  /** `jev-latest` (TypeSafe) / `jev-1.13` or `typesafe/jev-1.13` (OpenRouter). */
  readonly model: string
  /** Text, or structured data (object/array) describing the state to evaluate. */
  readonly state: unknown
  readonly questions: Questions
}

/** Response body for `POST /v1/systemone`. */
export interface SystemOneResponse {
  /** The model that performed the evaluation; on OpenRouter this is an OpenRouter model id. */
  readonly model: string
  readonly answers: Answers
  readonly usage?: Usage
  /** OpenRouter-only request id. */
  readonly id?: string
  /** OpenRouter-only serving provider label. */
  readonly provider?: string
}
