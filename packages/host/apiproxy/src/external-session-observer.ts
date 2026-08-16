/**
 * Observes session logs written by another process and exposes only their
 * append-only event tail to host stream owners.
 *
 * The observer never prepares or attaches a Session. Persistence remains the
 * source of truth, and a live Session in this process always wins over the
 * external read path.
 *
 * @module external-session-observer
 */

import { setTimeout as delay } from 'node:timers/promises'
import type { Session, SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionPersistence, SessionPersistenceRevision } from '@deepseek-ai/dsh-session-persistence'

/** Callbacks for one detached external-session observation. */
export interface ExternalSessionObserverCallbacks {
  /** Called once when a stored session is first visible to this observer. */
  readonly onSessionDiscovered: (meta: SessionHeader, events: readonly SessionEvent[]) => void
  /** Called with events whose seq is newer than the last delivered event. */
  readonly onEvents: (meta: SessionHeader, events: readonly SessionEvent[]) => void
}

/** Dependencies used by {@link ExternalSessionObserver}. */
export interface ExternalSessionObserverOptions extends ExternalSessionObserverCallbacks {
  /** Resolve the persistence service for the current host composition. */
  readonly persistence: () => SessionPersistence | undefined
  /** Return sessions owned by this process; these identities are never polled. */
  readonly liveSessions: () => readonly Session[]
  /** Poll cadence for detached session logs. */
  readonly pollIntervalMs: number
  /** Host logger used for retryable storage failures. */
  readonly warn: (message: string) => void
}

interface DiscoveredSession {
  readonly meta: SessionHeader
  readonly events: readonly SessionEvent[]
}

interface Cursor {
  readonly revision: SessionPersistenceRevision
  readonly nextSeq: number
}

/**
 * Poll a persistence backend while a Web stream is connected.
 *
 * A newly discovered log is indexed without replaying its existing history;
 * the Web client's history request supplies that baseline. Later reads start
 * at the next event seq, so only events appended after discovery are sent as
 * live mux frames.
 */
export class ExternalSessionObserver {
  private readonly cursors = new Map<SessionId, Cursor>()
  private readonly discovered = new Map<SessionId, DiscoveredSession>()
  private active = false
  private controller: AbortController | undefined

  constructor(private readonly options: ExternalSessionObserverOptions) {}

  /** Start one shared polling loop; repeated starts are idempotent. */
  start(): void {
    if (this.active) return
    this.active = true
    const controller = new AbortController()
    this.controller = controller
    void this.loop(controller)
  }

  /** Stop polling; a subsequent stream can start the same observer again. */
  stop(): void {
    this.active = false
    this.controller?.abort()
    this.controller = undefined
    this.cursors.clear()
    this.discovered.clear()
  }

  /**
   * Return sessions already indexed for a stream that connected later.
   *
   * @returns indexed session metadata and event history
   */
  knownSessions(): readonly DiscoveredSession[] {
    return [...this.discovered.values()]
  }

  private async loop(controller: AbortController): Promise<void> {
    while (!controller.signal.aborted) {
      try {
        await this.poll(controller.signal)
      } catch (error: unknown) {
        if (isAborted(controller.signal)) return
        this.options.warn(`external session observation failed; retrying: ${error instanceof Error ? error.message : String(error)}`)
      }
      await delay(this.options.pollIntervalMs, undefined, { signal: controller.signal }).catch(() => undefined)
    }
  }

  private async poll(signal: AbortSignal): Promise<void> {
    const persistence = this.options.persistence()
    if (persistence === undefined) return
    signal.throwIfAborted()
    const liveIds = new Set(this.options.liveSessions().map(session => session.id))
    const snapshots = await persistence.listSnapshots(signal)
    const storedIds = new Set<SessionId>()
    for (const snapshot of snapshots) {
      signal.throwIfAborted()
      storedIds.add(snapshot.header.id)
      if (liveIds.has(snapshot.header.id)) {
        this.cursors.delete(snapshot.header.id)
        this.discovered.delete(snapshot.header.id)
        continue
      }
      const prior = this.cursors.get(snapshot.header.id)
      if (prior === undefined) {
        const loaded = await persistence.readFrom(snapshot.header.id, 0, signal)
        signal.throwIfAborted()
        if (this.isLive(snapshot.header.id)) {
          this.cursors.delete(snapshot.header.id)
          continue
        }
        this.cursors.set(snapshot.header.id, {
          revision: snapshot.revision,
          nextSeq: nextSeqAfter(loaded.events),
        })
        this.discovered.set(snapshot.header.id, { meta: loaded.meta, events: loaded.events })
        this.options.onSessionDiscovered(loaded.meta, loaded.events)
        continue
      }
      if (prior.revision === snapshot.revision) continue

      const loaded = await persistence.readFrom(snapshot.header.id, prior.nextSeq, signal)
      signal.throwIfAborted()
      if (this.isLive(snapshot.header.id)) {
        this.cursors.delete(snapshot.header.id)
        this.discovered.delete(snapshot.header.id)
        continue
      }
      const events: SessionEvent[] = []
      let nextSeq = prior.nextSeq
      for (const event of loaded.events) {
        if (event.seq < nextSeq) continue
        if (event.seq !== nextSeq) {
          throw new Error(`external session "${snapshot.header.id}" has a seq gap at ${nextSeq}`)
        }
        events.push(event)
        nextSeq += 1
      }
      this.cursors.set(snapshot.header.id, { revision: snapshot.revision, nextSeq })
      const discovered = this.discovered.get(snapshot.header.id)
      if (discovered !== undefined && events.length > 0) {
        this.discovered.set(snapshot.header.id, {
          meta: loaded.meta,
          events: [...discovered.events, ...events],
        })
      }
      if (events.length > 0) this.options.onEvents(loaded.meta, events)
    }
    for (const id of this.cursors.keys()) {
      if (!storedIds.has(id)) {
        this.cursors.delete(id)
        this.discovered.delete(id)
      }
    }
  }

  private isLive(id: SessionId): boolean {
    return this.options.liveSessions().some(session => session.id === id)
  }
}

function nextSeqAfter(events: readonly SessionEvent[]): number {
  const tail = events.at(-1)
  return tail === undefined ? 0 : tail.seq + 1
}

function isAborted(signal: AbortSignal): boolean {
  return signal.aborted
}
