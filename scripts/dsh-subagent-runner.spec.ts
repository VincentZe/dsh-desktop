import { describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { parseRunnerArgs, changedGitPaths, executeRunnerRequest, RunnerUsageError, type RunnerProgressEvent, type RunnerRequest, type RunnerInteractionRequest } from './dsh-subagent-runner.ts'

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
    timeoutMs: 5_000,
    shutdownTimeoutMs: 100,
    disposeEofGraceMs: 100,
    disposeGraceMs: 100,
    progress: false,
    progressIntervalMs: 100,
    ...overrides,
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
    })
  })

  it('uses the DSH home session root by default and forwards explicit roots to the child env', () => {
    const parsed = parseRunnerArgs(['--task', 'inspect', '--session-root', '.runner-sessions'])
    expect(parsed.request).toMatchObject({
      sessionRoot: resolve(process.cwd(), '.runner-sessions'),
      env: { DSH_SESSION_ROOT: resolve(process.cwd(), '.runner-sessions') },
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
})

describe('changedGitPaths', () => {
  it('reports new, removed, and status-changed entries', () => {
    expect(changedGitPaths(
      [{ status: ' M', path: 'same.ts' }, { status: '??', path: 'removed.ts' }, { status: ' M', path: 'unchanged.ts' }],
      [{ status: 'M ', path: 'same.ts' }, { status: '??', path: 'added.ts' }, { status: ' M', path: 'unchanged.ts' }],
    )).toEqual(['added.ts', 'removed.ts', 'same.ts'])
  })
})

describe('executeRunnerRequest', () => {
  it('returns a machine-readable success result and closes the child', async () => {
    const result = await executeRunnerRequest(request())
    expect(result).toMatchObject({ schemaVersion: 1, status: 'completed', stopReason: 'completed', output: 'scripted answer' })
    expect(result.evidence.gitAvailable).toBe(true)
    expect(result.error).toBeUndefined()
  })

  it('keeps max-token termination visible as a non-error result', async () => {
    const result = await executeRunnerRequest(request({ env: { FAKE_REASON_KIND: 'max-tokens' } }))
    expect(result).toMatchObject({ status: 'max-tokens', stopReason: 'max-tokens' })
    expect(result.error).toBeUndefined()
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
})
