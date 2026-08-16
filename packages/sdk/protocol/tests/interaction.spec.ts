import { describe, expect, it } from 'vitest'
import { parseInteractionRequest, parseInteractionResponse } from '../src/index.ts'

const request = parseInteractionRequest({
  requestId: 'request-1',
  sessionId: 'session-1',
  questions: [{
    id: 'mode',
    question: 'Which mode?',
    options: [{ label: 'fast' }, { label: 'careful' }],
  }],
})

describe('interaction wire validation', () => {
  it('normalizes and validates a question request and matching answer', () => {
    expect(request).toMatchObject({ requestId: 'request-1', sessionId: 'session-1' })
    expect(parseInteractionResponse({
      requestId: 'request-1',
      answers: [{ id: 'mode', selected: ['fast'] }],
    }, request)).toEqual({
      requestId: 'request-1',
      answers: [{ id: 'mode', selected: ['fast'] }],
    })
  })

  it.each([
    [{ requestId: 'request-1', answers: [{ id: 'missing', selected: [] }] }, 'unknown question id'],
    [{ requestId: 'request-1', answers: [{ id: 'mode', selected: ['other'] }] }, 'not offered'],
    [{ requestId: 'request-1', answers: [{ id: 'mode', selected: ['fast', 'careful'] }] }, 'multiple options'],
  ])('rejects an invalid answer (%s)', (value, message) => {
    expect(() => parseInteractionResponse(value, request)).toThrow(message)
  })

  it('rejects duplicate question and answer ids', () => {
    expect(() => parseInteractionRequest({
      requestId: 'request-1',
      questions: [{ id: 'mode', question: 'One' }, { id: 'mode', question: 'Two' }],
    })).toThrow('duplicate question id')
    expect(() => parseInteractionResponse({
      requestId: 'request-1',
      answers: [{ id: 'mode', selected: [] }, { id: 'mode', selected: [] }],
    }, request)).toThrow('duplicate answer id')
  })
})
