import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import type { HarnessNotification, RunResult } from '@deepseek-ai/dsh-sdk-client'
import { bindWorkspaceToSession, parseRunnerArgs, changedGitPaths, executeRunnerRequest, notificationProgress, RunnerUsageError, taskWithWorkspace, type RunnerProgressEvent, type RunnerRequest, type RunnerInteractionRequest } from './dsh-subagent-runner.ts'

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

function sessionEvent(event: Record<string, unknown>, sessionId = 'session-1'): HarnessNotification {
  return {
    method: 'session.event',
    params: { sessionId, event },
  }
}

describe('parseRunnerArgs', () => {
  it('resolves a positional task and the repository runtime defaults', () => {
    const parsed = parseRunnerArgs(['inspect the workspace'])
    expect(parsed.help).toBe(false)
    expect(parsed.request).toMatchObject({
      task: 'inspect the workspace',
      command: process.execPath,
      args: [resolve(process.cwd(), 'packages/examples/jsonrpc-demo/lib/bin.js'), resolve(process.cwd(), 'examples/jsonrpc-agent/cordis.yml')],
      timeoutMs: 600_000,
      sessionRoot: dshHomePath('sessions'),
      permission: 'workspace-write',
      approval: 'ask',
    })
  })

  it('uses the DSH home session root by default and forwards explicit roots and workspace to the child env', () => {
    const parsed = parseRunnerArgs(['--task', 'inspect', '--session-root', '.runner-sessions'])
    expect(parsed.request).toMatchObject({
      sessionRoot: resolve(process.cwd(), '.runner-sessions'),
      env: { DSH_SESSION_ROOT: resolve(process.cwd(), '.runner-sessions'), DSH_CWD: process.cwd() },
    })
  })

  it('requires one task and rejects ambiguous runtime configuration', () => {
    expect(() => parseRunnerArgs([])).toThrow(RunnerUsageError)
    expect(() => parseRunnerArgs(['--task', 'a', 'b'])).toThrow('not both')
    expect(() => parseRunnerArgs(['--command', 'custom', 'task'])).toThrow('--command requires')
    expect(() => parseRunnerArgs(['--runtime-arg', 'bin.js', '--config', 'x.yml', 'task'])).toThrow('--config cannot')
  })

  it('supports explicit positive limits and help without starting a child', () => {
    expect(parseRunnerArgs(['--help'])).toEqual({ help: true })
    expect(parseRunnerArgs(['--', '--help'])).toEqual({ help: true })
    expect(parseRunnerArgs(['--task', 'a', '--timeout-ms', '42', '--max-tokens', '7']).request)
      .toMatchObject({ timeoutMs: 42, maxTokens: 7, progress: true, progressIntervalMs: 15_000 })
    expect(parseRunnerArgs(['--task', 'a', '--quiet', '--progress-ms', '9']).request)
      .toMatchObject({ progress: false, progressIntervalMs: 9 })
    expect(() => parseRunnerArgs(['--task', 'a', '--timeout-ms', '0'])).toThrow('positive integer')
  })

  it('resolves permission and approval defaults, including the safer full-access approval default', () => {
    expect(parseRunnerArgs(['--task', 'a']).request).toMatchObject({
      permission: 'workspace-write',
      approval: 'ask',
      env: {
        DSH_PERMISSION_MODE: 'workspace-write',
        DSH_APPROVAL_POLICY: 'ask',
      },
    })
    expect(parseRunnerArgs(['--task', 'a', '--permission', 'read-only']).request).toMatchObject({
      permission: 'read-only', approval: 'ask',
    })
    expect(parseRunnerArgs(['--task', 'a', '--permission', 'danger-full-access']).request).toMatchObject({
      permission: 'danger-full-access', approval: 'never',
    })
    expect(parseRunnerArgs(['--task', 'a', '--permission', 'danger-full-access', '--approval', 'ask']).request)
      .toMatchObject({ permission: 'danger-full-access', approval: 'ask' })
    expect(() => parseRunnerArgs(['--task', 'a', '--permission', 'unrestricted'])).toThrow('must be one of')
    expect(() => parseRunnerArgs(['--task', 'a', '--approval', 'always'])).toThrow('must be one of')
  })

  it('resolves Web workspace selection and lets --no-workspace override it', () => {
    expect(parseRunnerArgs(['--task', 'a', '--workspace-path', '.']).request).toMatchObject({
      workspace: { mode: 'path', path: process.cwd(), webUrl: 'http://127.0.0.1:3080', fallbackIfUnavailable: true },
    })
    expect(parseRunnerArgs(['--task', 'a', '--workspace-id', 'w1', '--web-url', 'https://dsh.test/base/']).request).toMatchObject({
      workspace: { mode: 'id', workspaceId: 'w1', webUrl: 'https://dsh.test/base' },
    })
    expect(parseRunnerArgs(['--task', 'a', '--workspace-path', '.', '--no-workspace']).request?.workspace).toBeUndefined()
    expect(() => parseRunnerArgs(['--task', 'a', '--workspace-id', 'w1', '--workspace-path', '.'])).toThrow('cannot be combined')
    expect(() => parseRunnerArgs(['--task', 'a', '--workspace-path', '.', '--web-url', 'file:///tmp/dsh'])).toThrow('http or https')
  })
})

describe('bindWorkspaceToSession', () => {
  it('creates or resolves a path workspace before attaching the settled session', async () => {
    const calls: Array<{ method: string; payload: Record<string, string> }> = []
    const urls: string[] = []
    const fetcher: typeof fetch = async (input, init) => {
      urls.push(input instanceof URL ? input.toString() : input instanceof Request ? input.url : input)
      const rawBody = typeof init?.body === 'string' ? init.body : ''
      const parsed: unknown = JSON.parse(rawBody) as unknown
      if (typeof parsed !== 'object' || parsed === null || !('method' in parsed) || !('payload' in parsed)
        || typeof parsed.method !== 'string' || typeof parsed.payload !== 'object' || parsed.payload === null) {
        throw new Error('invalid test request')
      }
      const body = parsed as { method: string; payload: Record<string, string> }
      calls.push({ method: body.method, payload: body.payload })
      if (body.method === 'workspace.create') {
        return new Response(JSON.stringify({
          type: 'server-response',
          rpcId: 'rpc-1',
          result: { ok: true, value: { workspace: { workspaceId: 'workspace-1' }, created: true } },
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return new Response(JSON.stringify({
        type: 'server-response',
        rpcId: 'rpc-2',
        result: { ok: true, value: { sessionId: 'session-1' } },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }

    await expect(bindWorkspaceToSession({
      mode: 'path', path: process.cwd(), webUrl: 'http://dsh.test/base', fallbackIfUnavailable: false,
    }, 'session-1', fetcher)).resolves.toMatchObject({
      status: 'bound', workspaceId: 'workspace-1', created: true, sessionId: 'session-1',
    })
    expect(calls).toEqual([
      { method: 'workspace.create', payload: { path: process.cwd() } },
      { method: 'session.create', payload: { sessionId: 'session-1', workspaceId: 'workspace-1' } },
    ])
    expect(urls).toEqual(['http://dsh.test/base/api/workspace.create', 'http://dsh.test/base/api/session.create'])
  })

  it('skips only a default path binding when the Web host is unavailable', async () => {
    const fetcher: typeof fetch = async () => { throw new Error('connect ECONNREFUSED') }
    const pathResult = await bindWorkspaceToSession({
      mode: 'path', path: process.cwd(), webUrl: 'http://127.0.0.1:3080', fallbackIfUnavailable: true,
    }, 'session-1', fetcher)
    expect(pathResult.status).toBe('skipped')
    const idResult = await bindWorkspaceToSession({
      mode: 'id', workspaceId: 'workspace-1', webUrl: 'http://127.0.0.1:3080',
    }, 'session-1', fetcher)
    expect(idResult.status).toBe('failed')
    expect(idResult.reason).toContain('ECONNREFUSED')
  })

  it('keeps Web API business errors visible as failed bindings', async () => {
    const fetcher: typeof fetch = async () => new Response(JSON.stringify({
      type: 'server-response', rpcId: 'rpc-1', result: {
        ok: false, error: { code: 'workspace-not-found', message: 'unknown workspace', details: {} },
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } })
    const result = await bindWorkspaceToSession({
      mode: 'id', workspaceId: 'missing', webUrl: 'http://dsh.test',
    }, 'session-1', fetcher)
    expect(result.status).toBe('failed')
    expect(result.reason).toContain('workspace-not-found')
  })
})

describe('taskWithWorkspace', () => {
  it('makes the resolved workspace visible while preserving the original task', () => {
    expect(taskWithWorkspace('review the changed files', 'D:\\Gitsources\\webview2-shell')).toBe([
      'Workspace for this task: D:\\Gitsources\\webview2-shell',
      'Use this exact absolute path for file and shell operations unless the task explicitly names another path.',
      '',
      'Task:',
      'review the changed files',
    ].join('\n'))
  })
})

describe('changedGitPaths', () => {
  it('reports new, removed, and status-changed entries', () => {
    expect(changedGitPaths(
      [{ status: ' M', path: 'same.ts' }, { status: '??', path: 'removed.ts' }, { status: ' M', path: 'unchanged.ts' }],
      [{ status: 'M ', path: 'same.ts' }, { status: '??', path: 'added.ts' }, { status: ' M', path: 'unchanged.ts' }],
    )).toEqual(['added.ts', 'removed.ts', 'same.ts'])
  })
})

describe('notificationProgress', () => {
  it('reports a bounded tool failure summary and correlates the result to its call', () => {
    const toolNames = new Map<string, string>()
    expect(notificationProgress(sessionEvent({
      type: 'tool/call',
      data: { name: 'bash', callId: 'call-1' },
    }), toolNames)).toMatchObject({ message: 'bash started', toolName: 'bash' })

    const progress = notificationProgress(sessionEvent({
      type: 'tool/result',
      data: {
        message: {
          source: { kind: 'tool', callId: 'call-1' },
          content: [{
            type: 'tool-result',
            toolCallId: 'call-1',
            isError: true,
            content: [{ type: 'text', text: 'Error: spawn bash ENOENT' }],
          }],
        },
        error: { name: 'ToolError', code: 'TOOL_FAILURE' },
      },
    }), toolNames)

    expect(progress).toMatchObject({
      phase: 'activity',
      message: 'bash failed',
      eventType: 'tool/result',
      toolName: 'bash',
      toolError: { name: 'ToolError', code: 'TOOL_FAILURE', message: 'Error: spawn bash ENOENT' },
    })
    expect(JSON.stringify(progress)).not.toContain('call-1')
  })

  it('caps and normalizes the error text exposed in progress', () => {
    const progress = notificationProgress(sessionEvent({
      type: 'tool/result',
      data: {
        message: {
          content: [{
            type: 'tool-result',
            toolCallId: 'call-2',
            isError: true,
            content: [{ type: 'text', text: `Error:\n${'x'.repeat(400)}` }],
          }],
        },
      },
    }))

    expect(progress?.toolError?.message).toHaveLength(240)
    expect(progress?.toolError?.message).not.toContain('\n')
  })

  it('redacts provider account and request identifiers from error text', () => {
    const progress = notificationProgress(sessionEvent({
      type: 'tool/result',
      data: {
        message: {
          content: [{
            type: 'tool-result',
            toolCallId: 'call-private',
            isError: true,
            content: [{ type: 'text', text: 'Your account (2121895707) failed; {"request_id":"req-private-123456"}' }],
          }],
        },
      },
    }))

    expect(progress?.toolError?.message).toBe('Your account ([redacted]) failed; {"request_id":"[redacted]"}')
  })
})

describe('executeRunnerRequest', () => {
  it('returns a machine-readable success result and closes the child', async () => {
    const result = await executeRunnerRequest(request())
    expect(result).toMatchObject({ schemaVersion: 1, status: 'completed', stopReason: 'completed', output: 'scripted answer' })
    expect(result.evidence.gitAvailable).toBe(true)
    expect(result.error).toBeUndefined()
  })

  it('derives the child workspace environment from the request cwd', async () => {
    const result = await executeRunnerRequest(request({ env: { FAKE_ECHO_ENV: 'DSH_CWD' } }))
    expect(result.output).toContain(`DSH_CWD=${process.cwd()}`)
  })

  it('keeps max-token termination visible as a non-error result', async () => {
    const result = await executeRunnerRequest(request({ env: { FAKE_REASON_KIND: 'max-tokens' } }))
    expect(result).toMatchObject({ status: 'max-tokens', stopReason: 'max-tokens' })
    expect(result.error).toBeUndefined()
  })

  it('preserves a structured child turn failure in the final result', async () => {
    const result = await executeRunnerRequest(request(), () => ({
      sessionId: 'fake-child',
      run: async (): Promise<RunResult> => ({
        sessionId: 'fake-child',
        finalResponse: '',
        events: [{
          type: 'turn/end',
          seq: 0,
          time: 0,
          data: { turn: 1, reason: { kind: 'error', error: { message: 'provider failed for account (2121895707)', code: 'INVALID_REQUEST' } } },
        }],
        notifications: [],
      }),
      close: async () => {},
    }))
    expect(result).toMatchObject({
      status: 'failed',
      stopReason: 'error',
      error: { name: 'ChildTurnError', message: 'provider failed for account ([redacted])', code: 'INVALID_REQUEST' },
    })
  })

  it('reports safe progress records without exposing task or tool arguments', async () => {
    const progress: RunnerProgressEvent[] = []
    const result = await executeRunnerRequest(request(), undefined, (event) => { progress.push(event) })
    expect(result.status).toBe('completed')
    expect(progress[0]).toMatchObject({ phase: 'started', model: 'fake-model' })
    expect(progress.map(event => event.eventType)).toContain('turn/start')
    expect(progress.at(-1)).toMatchObject({ phase: 'finished', resultStatus: 'completed' })
    expect(progress.every(event => !('task' in event) && !('arguments' in event))).toBe(true)
  })

  it('delegates structured child questions to the caller and keeps the run alive', async () => {
    const interactions: RunnerInteractionRequest[] = []
    const result = await executeRunnerRequest(
      request({ env: { FAKE_INTERACTION: '1', FAKE_TEXT: 'caller answered' } }),
      undefined,
      undefined,
      async (interaction) => {
        interactions.push(interaction)
        return { requestId: interaction.requestId, answers: [{ id: 'mode', selected: ['fast'] }] }
      },
    )
    expect(result).toMatchObject({ status: 'completed', output: 'caller answered' })
    expect(interactions).toHaveLength(1)
    expect(interactions[0]).toMatchObject({
      requestId: 'fake-interaction-1',
      questions: [{ id: 'mode', options: [{ label: 'fast' }, { label: 'careful' }] }],
    })
  })

  it('classifies a bounded child run timeout and still returns evidence', async () => {
    const result = await executeRunnerRequest(request({
      env: { FAKE_HANG_PROMPT: '1' },
      timeoutMs: 20,
      shutdownTimeoutMs: 20,
      disposeEofGraceMs: 20,
      disposeGraceMs: 20,
    }))
    expect(result.status).toBe('timed-out')
    expect(result.error?.name).toBe('RunnerTimeoutError')
    expect(result.evidence.gitAvailable).toBe(true)
  })

  it.skipIf(process.platform !== 'win32' || spawnSync('where.exe', ['git'], { windowsHide: true }).status !== 0)('makes PATH-resolved Git Bash available to the child', () => {
    const parsed = parseRunnerArgs(['--task', 'probe bash'])
    const result = spawnSync('bash', ['-lc', 'printf runner-bash-ok'], {
      cwd: parsed.request!.cwd,
      env: parsed.request!.env,
      encoding: 'utf8',
      windowsHide: true,
    })
    expect(result.error).toBeUndefined()
    expect(result.status).toBe(0)
    expect(result.stdout).toBe('runner-bash-ok')
  })
})
