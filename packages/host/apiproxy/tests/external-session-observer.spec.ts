import { describe, expect, it, vi } from 'vitest'
import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import { SessionPersistenceRevision, type SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import { ExternalSessionObserver } from '../src/external-session-observer.ts'

const id = 'external-session' as SessionId
const meta: SessionHeader = { version: 0, id, createdAt: 1, cwd: '/workspace' }
const event = (seq: number): SessionEvent => ({
  type: 'turn/start', seq, time: seq + 1, data: { turn: seq + 1 },
})

describe('ExternalSessionObserver', () => {
  it('indexes existing logs and emits only later contiguous events', async () => {
    let revision = SessionPersistenceRevision('r1')
    let events = [event(0)]
    const readFrom = vi.fn(async (_sessionId: SessionId, fromSeq: number) => ({
      meta,
      events: events.filter(candidate => candidate.seq >= fromSeq),
    }))
    const persistence = {
      listSnapshots: vi.fn(async () => [{ header: meta, revision }]),
      readFrom,
    } as unknown as SessionPersistence
    const discovered: SessionEvent[][] = []
    const appended: SessionEvent[][] = []
    const observer = new ExternalSessionObserver({
      persistence: () => persistence,
      liveSessions: () => [],
      pollIntervalMs: 1,
      warn: (message) => { throw new Error(message) },
      onSessionDiscovered: (_meta, initial) => { discovered.push([...initial]) },
      onEvents: (_meta, next) => { appended.push([...next]) },
    })

    observer.start()
    await vi.waitFor(() => { expect(discovered).toEqual([[event(0)]]) })
    events = [event(0), event(1)]
    revision = SessionPersistenceRevision('r2')
    await vi.waitFor(() => { expect(appended).toEqual([[event(1)]]) })
    expect(observer.knownSessions()).toEqual([{ meta, events: [event(0), event(1)] }])
    observer.stop()
    expect(observer.knownSessions()).toEqual([])
    expect(readFrom).toHaveBeenCalledWith(id, 1, expect.any(AbortSignal))
  })

  it('does not observe a session after this process attaches it', async () => {
    let attached = false
    const persistence = {
      listSnapshots: async () => [{ header: meta, revision: SessionPersistenceRevision('r1') }],
      readFrom: async () => ({ meta, events: [event(0)] }),
    } as unknown as SessionPersistence
    const onSessionDiscovered = vi.fn()
    const observer = new ExternalSessionObserver({
      persistence: () => persistence,
      liveSessions: () => attached ? [{ id } as never] : [],
      pollIntervalMs: 1,
      warn: vi.fn(),
      onSessionDiscovered,
      onEvents: vi.fn(),
    })

    observer.start()
    await vi.waitFor(() => { expect(onSessionDiscovered).toHaveBeenCalledOnce() })
    attached = true
    await new Promise(resolve => setTimeout(resolve, 5))
    observer.stop()
    expect(onSessionDiscovered).toHaveBeenCalledOnce()
  })
})
