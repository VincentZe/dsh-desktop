import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import {
  createRunnerJobRpcServer,
  type RunnerJobRpcServer,
} from './dsh-subagent-jobs-server.ts'
import type {
  RunnerJobExecutor,
} from './dsh-subagent-jobs.ts'
import { RunnerJobManager } from './dsh-subagent-jobs.ts'
import type {
  RunnerProgressEvent,
  RunnerRequest,
  RunnerResult,
} from './dsh-subagent-runner.ts'

function resultFor(request: RunnerRequest): RunnerResult {
  return {
    schemaVersion: 1,
    status: 'completed',
    output: 'server result',
    request: {
      cwd: request.cwd,
      command: request.command,
      args: request.args,
      provider: request.provider,
      model: request.model,
      permission: request.permission,
      approval: request.approval,
      timeoutMs: request.timeoutMs,
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

function executor(): RunnerJobExecutor {
  return async (request, onProgress) => {
    const event: RunnerProgressEvent = { schemaVersion: 1, type: 'progress', phase: 'started', message: 'server started' }
    onProgress(event)
    return resultFor(request)
  }
}

async function rpc(
  input: PassThrough,
  output: PassThrough,
  id: number,
  method: string,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let buffer = ''
    const timer = setTimeout(() => {
      output.off('data', onData)
      reject(new Error(`timed out waiting for ${method}`))
    }, 2_000)
    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString('utf8')
      const newline = buffer.indexOf('\n')
      if (newline < 0) return
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      const response = JSON.parse(line) as Record<string, unknown>
      if (response.id !== id) return
      clearTimeout(timer)
      output.off('data', onData)
      resolve(response)
    }
    output.on('data', onData)
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
  })
}

async function close(server: RunnerJobRpcServer, input: PassThrough): Promise<void> {
  await server.close()
  input.end()
}

describe('dsh-subagent-jobs-server', () => {
  it('maps JSON-RPC start and wait requests to the manager', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    const server = createRunnerJobRpcServer(input, output, { manager: new RunnerJobManager({ execute: executor() }) })
    try {
      const startResponse = await rpc(input, output, 1, 'job/start', {
        argv: ['--task', 'inspect', '--runtime-arg', 'fake-runtime'],
      })
      expect(startResponse.error).toBeUndefined()
      const started = startResponse.result as { jobId: string; status: string; cursor: number }
      expect(started.status).toBe('running')
      expect(started.cursor).toBe(0)

      let cursor = 0
      let snapshot: Record<string, unknown>
      let requestId = 2
      do {
        const waitResponse = await rpc(input, output, requestId++, 'job/wait', {
          jobId: started.jobId,
          afterCursor: cursor,
          timeoutMs: 1_000,
        })
        snapshot = waitResponse.result as Record<string, unknown>
        cursor = snapshot.nextCursor as number
      } while (snapshot.status === 'running')
      expect(snapshot.status).toBe('completed')
      expect((snapshot.result as Record<string, unknown>).output).toBe('server result')
    } finally {
      await close(server, input)
    }
  })

  it('returns protocol errors for malformed start and unknown jobs', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    const server = createRunnerJobRpcServer(input, output, { manager: new RunnerJobManager({ execute: executor() }) })
    try {
      const malformed = await rpc(input, output, 1, 'job/start', { argv: ['--task', 42] })
      expect(malformed.error).toMatchObject({ code: -32603 })
      const unknown = await rpc(input, output, 2, 'job/wait', { jobId: 'missing', timeoutMs: 0 })
      expect(unknown.error).toMatchObject({ code: -32603, message: 'unknown runner job: missing' })
    } finally {
      await close(server, input)
    }
  })

  it('cancels all jobs when the shutdown request is handled', async () => {
    let cancelled = false
    const execute: RunnerJobExecutor = async (_request, _onProgress, _onInteraction, signal) => {
      await new Promise<void>(resolve => signal.addEventListener('abort', () => { cancelled = true; resolve() }, { once: true }))
      throw new Error('cancelled')
    }
    let shutdownCalled = false
    const input = new PassThrough()
    const output = new PassThrough()
    const server = createRunnerJobRpcServer(input, output, {
      manager: new RunnerJobManager({ execute }),
      onShutdown: () => { shutdownCalled = true },
    })
    try {
      const startResponse = await rpc(input, output, 1, 'job/start', {
        argv: ['--task', 'hang', '--runtime-arg', 'fake-runtime'],
      })
      const started = startResponse.result as { jobId: string }
      const shutdown = await rpc(input, output, 2, 'job/shutdown', {})
      expect(shutdown.error).toBeUndefined()
      await new Promise<void>(resolveDelay => setImmediate(resolveDelay))
      expect(cancelled).toBe(true)
      expect(shutdownCalled).toBe(true)
      await expect(server.manager.wait(started.jobId, { timeoutMs: 0 })).resolves.toMatchObject({ status: 'aborted' })
    } finally {
      await close(server, input)
    }
  })
})
