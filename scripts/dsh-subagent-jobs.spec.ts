import { describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import {
  RunnerJobManager,
  type RunnerJobExecutor,
} from './dsh-subagent-jobs.ts'
import type {
  RunnerProgressEvent,
  RunnerRequest,
  RunnerResult,
} from './dsh-subagent-runner.ts'

const fakeRuntime = fileURLToPath(new URL('../packages/sdk/client/tests/fake-runtime.ts', import.meta.url))

function request(overrides: Partial<RunnerRequest> = {}): RunnerRequest {
  return {
    task: 'run the scripted task',
    cwd: process.cwd(),
    command: process.execPath,
    args: [fakeRuntime],
    env: { FAKE_TEXT: 'scripted answer' },
    sessionRoot: resolve(process.cwd(), '.sessions'),
    provider: 'fake-provider',
    model: 'fake-model',
    permission: 'workspace-write',
    approval: 'ask',
    timeoutMs: 5_000,
    shutdownTimeoutMs: 100,
    disposeEofGraceMs: 100,
    disposeGraceMs: 100,
    progress: false,
    progressIntervalMs: 100,
    ...overrides,
  }
}

function resultFor(requestValue: RunnerRequest): RunnerResult {
  return {
    schemaVersion: 1,
    status: 'completed',
    output: 'done',
    request: {
      cwd: requestValue.cwd,
      command: requestValue.command,
      args: requestValue.args,
      provider: requestValue.provider,
      model: requestValue.model,
      permission: requestValue.permission,
      approval: requestValue.approval,
      timeoutMs: requestValue.timeoutMs,
    },
    workspace: { status: 'not-requested' },
    evidence: {
      gitAvailable: false,
      before: [],
      after: [],
      changedPaths: [],
      diffCheck: { status: 'unavailable' },
    },
  }
}

async function waitUntil(
  manager: RunnerJobManager,
  jobId: string,
  predicate: (status: Awaited<ReturnType<RunnerJobManager['wait']>>) => boolean,
): Promise<Awaited<ReturnType<RunnerJobManager['wait']>>> {
  let cursor = 0
  for (;;) {
    const snapshot = await manager.wait(jobId, { afterCursor: cursor, timeoutMs: 5_000 })
    cursor = snapshot.nextCursor
    if (predicate(snapshot)) return snapshot
  }
}

describe('RunnerJobManager', () => {
  it('starts immediately and exposes the completed result through long polling', async () => {
    const manager = new RunnerJobManager()
    const started = manager.start(request())
    expect(started).toMatchObject({ status: 'running', cursor: 0 })

    const completed = await waitUntil(manager, started.jobId, snapshot => snapshot.status === 'completed')
    expect(completed.result).toMatchObject({ status: 'completed', output: 'scripted answer' })
    expect(completed.nextCursor).toBeGreaterThan(0)
    await expect(manager.wait(started.jobId, { afterCursor: completed.nextCursor, timeoutMs: 0 })).resolves.toMatchObject({
      status: 'completed',
      result: { output: 'scripted answer' },
      events: [],
    })
  })

  it('does not replay events and returns running after a bounded wait', async () => {
    const execute: RunnerJobExecutor = async (childRequest, onProgress, _onInteraction, signal) => {
      const event = (phase: RunnerProgressEvent['phase'], message: string): void => {
        onProgress({ schemaVersion: 1, type: 'progress', phase, message })
      }
      event('started', 'started')
      await new Promise(resolveDelay => setTimeout(resolveDelay, 30))
      if (signal.aborted) throw new Error('cancelled')
      event('activity', 'activity')
      return resultFor(childRequest)
    }
    const manager = new RunnerJobManager({ execute })
    const started = manager.start(request())
    const first = await manager.wait(started.jobId, { afterCursor: 0, timeoutMs: 100 })
    expect(first.events).toHaveLength(1)

    const second = await manager.wait(started.jobId, { afterCursor: first.nextCursor, timeoutMs: 1 })
    expect(second.status).toBe('running')
    expect(second.events).toHaveLength(0)

    const completed = await waitUntil(manager, started.jobId, snapshot => snapshot.status === 'completed')
    expect(completed.status).toBe('completed')
  })

  it('pauses on an interaction and resumes after respond', async () => {
    const manager = new RunnerJobManager()
    const started = manager.start(request({ env: { FAKE_INTERACTION: '1', FAKE_TEXT: 'caller answered' } }))
    const waiting = await waitUntil(manager, started.jobId, snapshot => snapshot.status === 'waiting-input')
    expect(waiting.pendingInteraction).toMatchObject({ requestId: 'fake-interaction-1' })

    manager.respond(started.jobId, {
      requestId: 'fake-interaction-1',
      answers: [{ id: 'mode', selected: ['fast'] }],
    })
    const completed = await waitUntil(manager, started.jobId, snapshot => snapshot.status === 'completed')
    expect(completed.result).toMatchObject({ output: 'caller answered' })
    expect(completed.pendingInteraction).toBeUndefined()
  })

  it('cancels a hanging child and leaves an aborted final result', async () => {
    const manager = new RunnerJobManager()
    const started = manager.start(request({
      env: { FAKE_HANG_PROMPT: '1' },
      shutdownTimeoutMs: 20,
      disposeEofGraceMs: 20,
      disposeGraceMs: 20,
    }))
    await manager.wait(started.jobId, { timeoutMs: 5_000 })
    await manager.cancel(started.jobId)

    const cancelled = await manager.wait(started.jobId, { afterCursor: 0, timeoutMs: 0 })
    expect(cancelled.status).toBe('aborted')
    expect(cancelled.result).toMatchObject({ status: 'aborted', error: { name: 'RunnerAbortError' } })
  })
})
