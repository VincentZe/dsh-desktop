/**
 * Wire validation for server-to-caller interaction requests.
 *
 * @module @deepseek-ai/dsh-sdk-protocol/interaction
 */

import type {
  AskUserQuestionAnswerItem,
  AskUserQuestionIntent,
  AskUserQuestionItem,
  AskUserQuestionOption,
} from '@deepseek-ai/dsh-user-questions/types'

/** A structured question request sent from a runtime to its caller. */
export interface InteractionRequestParams {
  /** Stable id used to match the caller's answer. */
  requestId: string
  /** Runtime session that is waiting, when the request came from an agent tool. */
  sessionId?: string
  /** Questions the caller must answer. */
  questions: AskUserQuestionItem[]
}

/** A structured answer returned by the caller for one interaction request. */
export interface InteractionResponseParams {
  /** The request id echoed from {@link InteractionRequestParams.requestId}. */
  requestId: string
  /** Answers keyed by question id. Omitted questions are treated as skipped. */
  answers: AskUserQuestionAnswerItem[]
}

/**
 * Validate one server-to-caller interaction request at the JSON-RPC boundary.
 * @param value - untrusted decoded JSON-RPC params.
 * @returns the validated question request.
 */
export function parseInteractionRequest(value: unknown): InteractionRequestParams {
  const record = asRecord(value, 'interaction request')
  const requestId = nonEmptyString(record.requestId, 'interaction requestId')
  const sessionId = optionalString(record.sessionId, 'interaction sessionId')
  if (!Array.isArray(record.questions) || record.questions.length === 0) {
    throw new TypeError('interaction request questions must be a non-empty array')
  }
  const questions = record.questions.map((question, index) => parseQuestion(question, index))
  const ids = new Set<string>()
  for (const question of questions) {
    if (ids.has(question.id)) throw new TypeError(`interaction request contains duplicate question id ${JSON.stringify(question.id)}`)
    ids.add(question.id)
  }
  return {
    requestId,
    ...(sessionId === undefined ? {} : { sessionId }),
    questions,
  }
}

/**
 * Validate one caller answer against its originating question request.
 * @param value - untrusted decoded JSON-RPC result.
 * @param request - the request whose question ids and options constrain the answer.
 * @returns the validated interaction answer.
 */
export function parseInteractionResponse(value: unknown, request: InteractionRequestParams): InteractionResponseParams {
  const record = asRecord(value, 'interaction response')
  const requestId = nonEmptyString(record.requestId, 'interaction response requestId')
  if (requestId !== request.requestId) throw new TypeError(`interaction response requestId ${JSON.stringify(requestId)} does not match ${JSON.stringify(request.requestId)}`)
  if (!Array.isArray(record.answers)) throw new TypeError('interaction response answers must be an array')
  const questions = new Map(request.questions.map(question => [question.id, question]))
  const answered = new Set<string>()
  const answers = record.answers.map((answer, index) => {
    const parsed = parseAnswer(answer, index)
    if (answered.has(parsed.id)) throw new TypeError(`interaction response contains duplicate answer id ${JSON.stringify(parsed.id)}`)
    answered.add(parsed.id)
    const question = questions.get(parsed.id)
    if (question === undefined) throw new TypeError(`interaction response names unknown question id ${JSON.stringify(parsed.id)}`)
    validateSelectedOptions(parsed, question)
    return parsed
  })
  return { requestId, answers }
}

function parseQuestion(value: unknown, index: number): AskUserQuestionItem {
  const record = asRecord(value, `interaction question ${index}`)
  const id = nonEmptyString(record.id, `interaction question ${index} id`)
  const question = nonEmptyString(record.question, `interaction question ${index} question`)
  const detail = optionalString(record.detail, `interaction question ${index} detail`)
  const header = optionalString(record.header, `interaction question ${index} header`)
  const multiSelect = optionalBoolean(record.multiSelect, `interaction question ${index} multiSelect`)
  const options = record.options === undefined
    ? undefined
    : parseOptions(record.options, index)
  const intent = record.intent === undefined ? undefined : parseIntent(record.intent, index)
  return {
    id,
    question,
    ...(detail === undefined ? {} : { detail }),
    ...(header === undefined ? {} : { header }),
    ...(options === undefined ? {} : { options }),
    ...(multiSelect === undefined ? {} : { multiSelect }),
    ...(intent === undefined ? {} : { intent }),
  }
}

function parseOptions(value: unknown, questionIndex: number): AskUserQuestionOption[] {
  if (!Array.isArray(value)) throw new TypeError(`interaction question ${questionIndex} options must be an array`)
  const labels = new Set<string>()
  return value.map((option, optionIndex) => {
    const record = asRecord(option, `interaction question ${questionIndex} option ${optionIndex}`)
    const label = nonEmptyString(record.label, `interaction question ${questionIndex} option ${optionIndex} label`)
    if (labels.has(label)) throw new TypeError(`interaction question ${questionIndex} contains duplicate option label ${JSON.stringify(label)}`)
    labels.add(label)
    const description = optionalString(record.description, `interaction question ${questionIndex} option ${optionIndex} description`)
    return description === undefined ? { label } : { label, description }
  })
}

function parseIntent(value: unknown, questionIndex: number): AskUserQuestionIntent {
  const record = asRecord(value, `interaction question ${questionIndex} intent`)
  if (record.kind !== 'plan-review') throw new TypeError(`interaction question ${questionIndex} has an unknown intent kind`)
  return { kind: 'plan-review', approve: nonEmptyString(record.approve, `interaction question ${questionIndex} intent approve`) }
}

function parseAnswer(value: unknown, index: number): AskUserQuestionAnswerItem {
  const record = asRecord(value, `interaction answer ${index}`)
  const id = nonEmptyString(record.id, `interaction answer ${index} id`)
  if (!Array.isArray(record.selected) || !record.selected.every(item => typeof item === 'string')) {
    throw new TypeError(`interaction answer ${index} selected must be a string array`)
  }
  const custom = optionalString(record.custom, `interaction answer ${index} custom`)
  const selected = [...record.selected]
  if (new Set(selected).size !== selected.length) throw new TypeError(`interaction answer ${index} selected contains duplicate labels`)
  return custom === undefined ? { id, selected } : { id, selected, custom }
}

function validateSelectedOptions(answer: AskUserQuestionAnswerItem, question: AskUserQuestionItem): void {
  const labels = new Set((question.options ?? []).map(option => option.label))
  if (answer.selected.some(label => !labels.has(label))) {
    throw new TypeError(`interaction answer for ${JSON.stringify(answer.id)} selects an option not offered by the question`)
  }
  if (question.multiSelect !== true && answer.selected.length > 1) {
    throw new TypeError(`interaction answer for ${JSON.stringify(answer.id)} selects multiple options for a single-select question`)
  }
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError(`${label} must be an object`)
  return value as Record<string, unknown>
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${label} must be a non-empty string`)
  return value
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new TypeError(`${label} must be a string`)
  return value
}

function optionalBoolean(value: unknown, label: string): boolean | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') throw new TypeError(`${label} must be a boolean`)
  return value
}
