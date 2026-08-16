import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import { SessionPersistenceRevision, type SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import type { MuxFrame, RpcRequest } from '@deepseek-ai/dsh-host-apiproxy/api'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy/api/rpc'
import { createApiProxy } from '../src/api-proxy.ts'

const sessionId = 'external-mux-session' as SessionId
const meta: SessionHeader = { version: 0, id: sessionId, createdAt: 1, cwd: '/workspace' }
const event = (seq: number): SessionEvent => ({
  type: 'turn/start', seq, time: seq + 1, data: { turn: seq + 1 },
})

describe('ApiProxy external sessions', () => {
  it('pushes appended external events through the mux without attaching the session', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(UserQuestionService)
    let revision = SessionPersistenceRevision('r1')
    let stored = [event(0)]
    const readFrom = vi.fn(async (_id: SessionId, fromSeq: number) => ({
      meta,
      events: stored.filter(candidate => candidate.seq >= fromSeq),
    }))
    const persistence = {
      listSnapshots: vi.fn(async () => [{ header: meta, revision }]),
      readFrom,
    } as unknown as SessionPersistence
    ctx.provide('sessionPersistence', persistence)
    const api = createApiProxy(ctx, {
      defaultModelSelection: () => ({ provider: 'p', model: 'm' }),
      cwd: '/workspace',
      externalSessionPollMs: 1,
    })
    const abort = new AbortController()
    const stream = api.events.mux({ rpcId: RpcId('external-mux'), payload: {} }, abort.signal)
    const iterator = stream[Symbol.asyncIterator]()
    await vi.waitFor(() => { expect(readFrom).toHaveBeenCalledWith(sessionId, 0, expect.any(AbortSignal)) })
    const nextPromise = iterator.next()
    stored = [event(0), event(1)]
    revision = SessionPersistenceRevision('r2')
    const next = await nextPromise
    const received: RpcRequest<MuxFrame> | undefined = next.done === true ? undefined : next.value
    expect(received?.payload).toMatchObject({ type: 'session/event', sessionId, event: event(1) })

    ctx.provide('workspaceRegistry', { list: () => [], archivedSessionIds: [] } as never)
    const hostAbort = new AbortController()
    const hostStream = api.events.host({ rpcId: RpcId('external-host-later'), payload: {} }, hostAbort.signal)
    const hostIterator = hostStream[Symbol.asyncIterator]()
    const hostNext = await hostIterator.next()
    hostAbort.abort()
    await hostIterator.next()
    expect(hostNext.done === true ? undefined : hostNext.value.payload).toMatchObject({
      type: 'host/session-added',
      sessionId,
      blank: false,
      cwd: '/workspace',
    })
    abort.abort()
    await iterator.next()
    expect(ctx.sessions.get(sessionId)).toBeUndefined()
  })

  it('announces a newly observed external session on the host stream', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(UserQuestionService)
    ctx.provide('workspaceRegistry', { list: () => [], archivedSessionIds: [] } as never)
    const persistence = {
      listSnapshots: async () => [{ header: meta, revision: SessionPersistenceRevision('r1') }],
      readFrom: async () => ({ meta, events: [event(0)] }),
    } as unknown as SessionPersistence
    ctx.provide('sessionPersistence', persistence)
    const api = createApiProxy(ctx, {
      defaultModelSelection: () => ({ provider: 'p', model: 'm' }),
      cwd: '/workspace',
      externalSessionPollMs: 1,
    })
    const abort = new AbortController()
    const stream = api.events.host({ rpcId: RpcId('external-host'), payload: {} }, abort.signal)
    const iterator = stream[Symbol.asyncIterator]()
    const nextPromise = iterator.next()
    const next = await nextPromise
    const received = next.done === true ? undefined : next.value.payload
    abort.abort()
    await iterator.next()
    expect(received).toMatchObject({
      type: 'host/session-added',
      sessionId,
      blank: false,
      cwd: '/workspace',
    })
  })
})
