/**
 * In-process lifecycle manager for supervised dsh child runs.
 *
 * The manager deliberately owns no transport. Adapters can expose the same
 * start/wait/respond/cancel operations through stdio JSON-RPC, MCP, or a host
 * API without changing runner execution or interaction semantics.
 *
 * @module dsh-subagent-jobs
 */

import { randomUUID } from 'node:crypto'
import {
  parseInteractionResponse,
  type InteractionRequestParams,
  type InteractionResponseParams,
} from '@deepseek-ai/dsh-sdk-protocol'
import {
  executeRunnerRequest,
  type RunnerInteractionHandler,
  type RunnerInteractionRequest,
  type RunnerInteractionAnswer,
  type RunnerProgressEvent,
  type RunnerProgressSink,
  type RunnerRequest,
  type RunnerResult,
  type RunnerStatus,
} from './dsh-subagent-runner.ts'

const DEFAULT_WAIT_TIMEOUT_MS = 30_000
const MAX_WAIT_TIMEOUT_MS = 2_147_483_647

/** State exposed while one managed child run is active or settled. */
export type RunnerJobStatus = 'running' | 'waiting-input' | RunnerStatus

/** One progress event with the job-local cursor assigned by the manager. */
export interface RunnerJobEvent {
  readonly cursor: number
  readonly event: RunnerProgressEvent
}

/** Immediate result returned by {@link RunnerJobManager.start}. */
export interface RunnerJobStart {
  readonly jobId: string
  readonly status: 'running'
  /** Pass this value as `afterCursor` to avoid replaying prior events. */
  readonly cursor: number
}

/** Options for one long-polling read of a managed child run. */
export interface RunnerJobWaitOptions {
  /** Return only events whose cursor is greater than this value. */
  readonly afterCursor?: number
  /** Maximum time to wait for an event or terminal state. Zero is immediate. */
  readonly timeoutMs?: number
}

/** Snapshot returned by a job wait, including only events after the cursor. */
export interface RunnerJobSnapshot {
  readonly jobId: string
  readonly status: RunnerJobStatus
  readonly events: readonly RunnerJobEvent[]
  /** Latest cursor; pass it back as `afterCursor` on the next wait. */
  readonly nextCursor: number
  readonly result?: RunnerResult
  readonly error?: { readonly name: string; readonly message: string }
  readonly pendingInteraction?: RunnerInteractionRequest
}

/** Executor injected by tests or a future runner implementation. */
export type RunnerJobExecutor = (
  request: RunnerRequest,
  onProgress: RunnerProgressSink,
  onInteraction: RunnerInteractionHandler,
  signal: AbortSignal,
) => Promise<RunnerResult>

/** Error raised when a job id is not owned by a manager. */
export class RunnerJobNotFoundError extends Error {
  constructor(jobId: string) {
    super(`unknown runner job: ${jobId}`)
    this.name = 'RunnerJobNotFoundError'
  }
}

/** Error raised when a lifecycle operation is invalid for the current state. */
export class RunnerJobStateError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RunnerJobStateError'
  }
}

class RunnerJobCancelledError extends Error {
  constructor() {
    super('runner job was cancelled')
    this.name = 'RunnerJobCancelledError'
  }
}

interface PendingInteraction {
  readonly request: InteractionRequestParams
  readonly resolve: (answer: InteractionResponseParams) => void
  readonly reject: (error: Error) => void
}

interface JobWaiter {
  readonly afterCursor: number
  readonly resolve: (snapshot: RunnerJobSnapshot) => void
  timer?: ReturnType<typeof setTimeout>
}

interface RunnerJobRecord {
  readonly jobId: string
  readonly request: RunnerRequest
  readonly abortController: AbortController
  readonly events: RunnerJobEvent[]
  readonly waiters: Set<JobWaiter>
  nextCursor: number
  status: RunnerJobStatus
  result?: RunnerResult
  error?: { readonly name: string; readonly message: string }
  pendingInteraction?: PendingInteraction | undefined
  completion: Promise<void>
}

/**
 * Owns process-local supervised child jobs until the manager is discarded.
 * Terminal jobs remain readable so a caller can fetch the final result after
 * a delayed poll; persistence and cross-process ownership belong to a later
 * transport layer.
 */
export class RunnerJobManager {
  private readonly jobs = new Map<string, RunnerJobRecord>()
  private readonly execute: RunnerJobExecutor
  private readonly createJobId: () => string

  /**
   * @param options - optional executor and id factory used by adapters/tests.
   */
  constructor(options: { readonly execute?: RunnerJobExecutor; readonly createJobId?: () => string } = {}) {
    this.execute = options.execute ?? ((request, onProgress, onInteraction, signal) => executeRunnerRequest(
      request,
      undefined,
      onProgress,
      onInteraction,
      signal,
    ))
    this.createJobId = options.createJobId ?? (() => `job-${randomUUID().replaceAll('-', '')}`)
  }

  /**
   * Start a child run and return before the child produces its first result.
   * @param request - fully resolved runner request.
   * @returns the new job id and initial cursor.
   */
  start(request: RunnerRequest): RunnerJobStart {
    let jobId = this.createJobId()
    while (this.jobs.has(jobId)) jobId = this.createJobId()
    const job: RunnerJobRecord = {
      jobId,
      request,
      abortController: new AbortController(),
      events: [],
      waiters: new Set(),
      nextCursor: 0,
      status: 'running',
      completion: Promise.resolve(),
    }
    this.jobs.set(jobId, job)
    job.completion = this.run(job)
    return { jobId, status: 'running', cursor: 0 }
  }

  /**
   * Wait for new progress, a pending interaction, a terminal result, or the
   * requested timeout.
   * @param jobId - manager-owned job id.
   * @param options - cursor and long-polling options.
   * @returns a snapshot containing events after `afterCursor`.
   */
  wait(jobId: string, options: RunnerJobWaitOptions = {}): Promise<RunnerJobSnapshot> {
    const job = this.get(jobId)
    const afterCursor = validateCursor(options.afterCursor)
    const timeoutMs = validateTimeout(options.timeoutMs)
    if (this.ready(job, afterCursor) || timeoutMs === 0) return Promise.resolve(this.snapshot(job, afterCursor))
    return new Promise<RunnerJobSnapshot>((resolve) => {
      const waiter: JobWaiter = { afterCursor, resolve }
      waiter.timer = setTimeout(() => this.resolveWaiter(job, waiter), timeoutMs)
      job.waiters.add(waiter)
    })
  }

  /**
   * Validate and deliver an answer to the job's current interaction request.
   * @param jobId - manager-owned job id.
   * @param answer - answer whose request id and selections match the request.
   */
  respond(jobId: string, answer: RunnerInteractionAnswer): void {
    const job = this.get(jobId)
    const pending = job.pendingInteraction
    if (pending === undefined) throw new RunnerJobStateError(`runner job ${jobId} is not waiting for interaction`)
    const parsed = parseInteractionResponse(answer, pending.request)
    job.pendingInteraction = undefined
    job.status = 'running'
    pending.resolve(parsed)
  }

  /**
   * Cancel a running job and wait until its child has been reaped.
   * @param jobId - manager-owned job id.
   * @returns settlement after the final job snapshot is observable.
   */
  async cancel(jobId: string): Promise<void> {
    const job = this.get(jobId)
    if (isTerminal(job.status)) return
    const pending = job.pendingInteraction
    job.pendingInteraction = undefined
    job.status = 'running'
    pending?.reject(new RunnerJobCancelledError())
    job.abortController.abort()
    await job.completion
  }

  /**
   * Cancel every non-terminal job and wait for all child processes to settle.
   * @returns settlement after every managed child has been reaped.
   */
  async cancelAll(): Promise<void> {
    await Promise.all([...this.jobs.keys()].map(jobId => this.cancel(jobId)))
  }

  private async run(job: RunnerJobRecord): Promise<void> {
    const onProgress: RunnerProgressSink = event => this.recordEvent(job, event)
    const onInteraction: RunnerInteractionHandler = request => this.awaitInteraction(job, request)
    try {
      const result = await this.execute(job.request, onProgress, onInteraction, job.abortController.signal)
      job.result = result
      job.status = result.status
      job.pendingInteraction = undefined
      this.notify(job)
    } catch (error: unknown) {
      const cancelled = job.abortController.signal.aborted
      const terminalStatus: RunnerStatus = cancelled ? 'aborted' : 'failed'
      job.status = terminalStatus
      job.error = cancelled
        ? { name: 'RunnerAbortError', message: 'child run was cancelled' }
        : errorDetails(error)
      this.recordEvent(job, {
        schemaVersion: 1,
        type: 'progress',
        phase: 'finished',
        message: cancelled ? 'child run aborted before producing a result' : 'child run failed before producing a result',
        resultStatus: terminalStatus,
      })
      this.notify(job)
    }
  }

  private awaitInteraction(job: RunnerJobRecord, request: RunnerInteractionRequest): Promise<RunnerInteractionAnswer> {
    if (isTerminal(job.status) || job.abortController.signal.aborted) return Promise.reject(new RunnerJobCancelledError())
    return new Promise<RunnerInteractionAnswer>((resolve, reject) => {
      job.pendingInteraction = { request, resolve, reject }
      job.status = 'waiting-input'
      this.notify(job)
    })
  }

  private recordEvent(job: RunnerJobRecord, event: RunnerProgressEvent): void {
    const cursor = job.nextCursor + 1
    job.nextCursor = cursor
    job.events.push({ cursor, event })
    if (event.phase === 'interaction') job.status = 'waiting-input'
    if (event.phase !== 'finished' && event.phase !== 'interaction') this.notify(job)
  }

  private get(jobId: string): RunnerJobRecord {
    const job = this.jobs.get(jobId)
    if (job === undefined) throw new RunnerJobNotFoundError(jobId)
    return job
  }

  private ready(job: RunnerJobRecord, afterCursor: number): boolean {
    return isTerminal(job.status) || job.pendingInteraction !== undefined || job.nextCursor > afterCursor
  }

  private snapshot(job: RunnerJobRecord, afterCursor: number): RunnerJobSnapshot {
    return {
      jobId: job.jobId,
      status: job.status,
      events: job.events.filter(item => item.cursor > afterCursor),
      nextCursor: job.nextCursor,
      ...(job.result === undefined ? {} : { result: job.result }),
      ...(job.error === undefined ? {} : { error: job.error }),
      ...(job.pendingInteraction === undefined ? {} : { pendingInteraction: job.pendingInteraction.request }),
    }
  }

  private notify(job: RunnerJobRecord): void {
    for (const waiter of [...job.waiters]) {
      if (this.ready(job, waiter.afterCursor)) this.resolveWaiter(job, waiter)
    }
  }

  private resolveWaiter(job: RunnerJobRecord, waiter: JobWaiter): void {
    if (!job.waiters.delete(waiter)) return
    if (waiter.timer !== undefined) clearTimeout(waiter.timer)
    waiter.resolve(this.snapshot(job, waiter.afterCursor))
  }
}

function isTerminal(status: RunnerJobStatus): status is RunnerStatus {
  return status !== 'running' && status !== 'waiting-input'
}

function validateCursor(value: number | undefined): number {
  if (value === undefined) return 0
  if (!Number.isSafeInteger(value) || value < 0) throw new RunnerJobStateError('afterCursor must be a non-negative safe integer')
  return value
}

function validateTimeout(value: number | undefined): number {
  const timeoutMs = value ?? DEFAULT_WAIT_TIMEOUT_MS
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > MAX_WAIT_TIMEOUT_MS) {
    throw new RunnerJobStateError(`timeoutMs must be an integer from 0 to ${MAX_WAIT_TIMEOUT_MS}`)
  }
  return timeoutMs
}

function errorDetails(error: unknown): { readonly name: string; readonly message: string } {
  return error instanceof Error
    ? { name: error.name, message: error.message }
    : { name: 'UnknownError', message: String(error) }
}
