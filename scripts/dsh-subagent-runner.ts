#!/usr/bin/env node
/**
 * Supervises one out-of-process DeepSeek Harness task through the SDK client.
 * The runner owns the caller-facing JSON result, bounded teardown, and
 * workspace evidence; the child runtime owns the agent composition.
 *
 * @module dsh-subagent-runner
 */

import { existsSync, statSync } from 'node:fs'
import { createInterface, type Interface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { isAbsolute, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { parseArgs } from 'node:util'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import {
  DeepSeekHarness,
  JsonRpcResponseError,
  RequestTimeoutError,
  SdkProtocolError,
  TransportClosedError,
  type HarnessNotification,
  type RunResult,
} from '@deepseek-ai/dsh-sdk-client'
import {
  parseInteractionRequest,
  parseInteractionResponse,
  type InteractionRequestParams,
  type InteractionResponseParams,
  type JsonRpcRequestHandler,
} from '@deepseek-ai/dsh-sdk-protocol'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'

const REPOSITORY_ROOT = resolve(fileURLToPath(new URL('../', import.meta.url)))
const DEFAULT_RUNTIME_BIN = resolve(REPOSITORY_ROOT, 'packages/examples/jsonrpc-demo/lib/bin.js')
const DEFAULT_CONFIG = resolve(REPOSITORY_ROOT, 'examples/jsonrpc-agent/cordis.yml')
const DEFAULT_TIMEOUT_MS = 600_000
const MAX_CAPTURED_STATUS_LINES = 400

/** Stable result statuses emitted by the runner. */
export type RunnerStatus = 'completed' | 'max-tokens' | 'aborted' | 'timed-out' | 'failed'

/** One status entry observed from `git status --porcelain=v1`. */
export interface GitStatusEntry {
  readonly status: string
  readonly path: string
}

/** One bounded check result returned in the evidence section. */
export interface CheckResult {
  readonly status: 'passed' | 'failed' | 'unavailable'
  readonly detail?: string
}

/** Workspace evidence collected around the child run. */
export interface WorkspaceEvidence {
  readonly gitAvailable: boolean
  readonly before: readonly GitStatusEntry[]
  readonly after: readonly GitStatusEntry[]
  readonly changedPaths: readonly string[]
  readonly diffCheck: CheckResult
}

/** Fully resolved child launch and supervision request. */
export interface RunnerRequest {
  readonly task: string
  readonly cwd: string
  readonly command: string
  readonly args: readonly string[]
  readonly env: Readonly<Record<string, string>>
  readonly sessionRoot: string
  readonly provider: string
  readonly model: string
  readonly maxTokens?: number
  readonly timeoutMs: number
  readonly shutdownTimeoutMs: number
  readonly disposeEofGraceMs: number
  readonly disposeGraceMs: number
  readonly progress: boolean
  readonly progressIntervalMs: number
}

/** Structured question request delivered to the runner's caller policy. */
export type RunnerInteractionRequest = InteractionRequestParams

/** Structured answer returned by the runner's caller policy. */
export type RunnerInteractionAnswer = InteractionResponseParams

/** Caller-owned policy for deciding a child interaction request. */
export type RunnerInteractionHandler = (request: RunnerInteractionRequest) => Promise<RunnerInteractionAnswer>

/** JSON result returned on stdout for every accepted request. */
export interface RunnerResult {
  readonly schemaVersion: 1
  readonly status: RunnerStatus
  readonly stopReason?: string
  readonly output: string
  readonly request: {
    readonly cwd: string
    readonly command: string
    readonly args: readonly string[]
    readonly provider: string
    readonly model: string
    readonly timeoutMs: number
  }
  readonly evidence: WorkspaceEvidence
  readonly error?: {
    readonly name: string
    readonly message: string
  }
}

/** One bounded progress record emitted as JSON Lines on stderr. */
export interface RunnerProgressEvent {
  readonly schemaVersion: 1
  readonly type: 'progress'
  readonly phase: 'started' | 'activity' | 'heartbeat' | 'interaction' | 'finished'
  readonly message: string
  readonly elapsedMs?: number
  readonly method?: string
  readonly eventType?: string
  readonly provider?: string
  readonly model?: string
  readonly resultStatus?: RunnerStatus
  readonly stopReason?: string
  readonly interaction?: RunnerInteractionRequest
}

/** Sink for progress records observed during one child run. */
export type RunnerProgressSink = (event: RunnerProgressEvent) => void

/** Error raised when command-line input cannot form a runner request. */
export class RunnerUsageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RunnerUsageError'
  }
}

/** Parsed command-line invocation. */
export interface RunnerInvocation {
  readonly help: boolean
  readonly request?: RunnerRequest
}

/** CLI usage text. */
export const RUNNER_USAGE = `Usage:
  pnpm dsh:subagent -- "task text"

Options:
  --task, -t <text>             task text (or one positional argument)
  --cwd <path>                  child workspace (default: current directory)
  --session-root <path>         shared JSONL session root (default: $DSH_HOME/sessions)
  --config <path>               child cordis.yml for the default runtime
  --command <path>              child command (default: current Node.js)
  --runtime-arg <arg>           replace default runtime arguments (repeatable)
  --provider <name>             child model provider (default: deepseek-official)
  --model <name>                child model (default: deepseek-v4-flash)
  --max-tokens <positive-int>   child request output cap
  --timeout-ms <positive-int>   wall-clock run limit (default: 600000)
  --progress-ms <positive-int>  idle progress heartbeat interval (default: 15000)
  --quiet                       suppress progress JSON Lines on stderr
  --forward-env <name>          explicitly copy one parent env value to child
  --help, -h                    print this help

The default child is the built dsh-jsonrpc-agent with examples/jsonrpc-agent/cordis.yml.
If the child asks a structured question, stderr emits an interaction progress record and
the caller must write one JSON answer line to stdin:
  {"requestId":"...","answers":[{"id":"...","selected":["..."]}]}
Run pnpm run build before using the default child runtime.`

function parsePositiveInteger(name: string, raw: string | undefined, defaultValue?: number): number {
  if (raw === undefined) {
    if (defaultValue === undefined) throw new RunnerUsageError(`--${name} is required`)
    return defaultValue
  }
  if (!/^\d+$/.test(raw)) throw new RunnerUsageError(`--${name} must be a positive integer`)
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value <= 0) throw new RunnerUsageError(`--${name} must be a positive integer`)
  return value
}

function resolveDirectory(raw: string | undefined, label: string): string {
  const directory = resolve(raw ?? process.cwd())
  if (!existsSync(directory) || !statSync(directory).isDirectory()) {
    throw new RunnerUsageError(`${label} must name an existing directory: ${directory}`)
  }
  return directory
}

function resolveFile(raw: string | undefined, label: string, fallback: string): string {
  const file = resolve(raw ?? fallback)
  if (!existsSync(file) || !statSync(file).isFile()) throw new RunnerUsageError(`${label} must name an existing file: ${file}`)
  return file
}

function resolvePath(raw: string | undefined, fallback: string): string {
  return resolve(raw ?? fallback)
}

function resolveEnv(names: readonly string[] | undefined): Record<string, string> {
  const env = scrubbedParentEnv()
  for (const name of names ?? []) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new RunnerUsageError(`--forward-env has an invalid name: ${name}`)
    const value = process.env[name]
    if (value !== undefined) env[name] = value
  }
  return env
}

/** Parse CLI arguments into one resolved request without starting a process. */
export function parseRunnerArgs(argv: readonly string[]): RunnerInvocation {
  const normalizedArgv = argv[0] === '--' ? argv.slice(1) : argv
  const parsed = parseArgs({
    args: [...normalizedArgv],
    options: {
      task: { type: 'string', short: 't' },
      cwd: { type: 'string' },
      'session-root': { type: 'string' },
      config: { type: 'string' },
      command: { type: 'string' },
      'runtime-arg': { type: 'string', multiple: true },
      provider: { type: 'string' },
      model: { type: 'string' },
      'max-tokens': { type: 'string' },
      'timeout-ms': { type: 'string' },
      'progress-ms': { type: 'string' },
      'shutdown-timeout-ms': { type: 'string' },
      'dispose-eof-grace-ms': { type: 'string' },
      'dispose-grace-ms': { type: 'string' },
      'forward-env': { type: 'string', multiple: true },
      quiet: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: true,
    strict: true,
  })
  const values = parsed.values
  if (values.help === true) return { help: true }
  if (values.task !== undefined && parsed.positionals.length > 0) throw new RunnerUsageError('provide task as --task or one positional argument, not both')
  if (parsed.positionals.length > 1) throw new RunnerUsageError('only one positional task is allowed')
  const task = values.task ?? parsed.positionals[0]
  if (task === undefined || task.trim() === '') throw new RunnerUsageError('a non-empty task is required')

  const runtimeArgs = values['runtime-arg']
  if (runtimeArgs !== undefined && values.config !== undefined) throw new RunnerUsageError('--config cannot be combined with --runtime-arg')
  const command = values.command ?? process.execPath
  if (runtimeArgs === undefined && command !== process.execPath) {
    throw new RunnerUsageError('--command requires --runtime-arg when it is not the current Node.js executable')
  }
  const cwd = resolveDirectory(values.cwd, '--cwd')
  const sessionRoot = resolvePath(values['session-root'], dshHomePath('sessions'))
  const args = runtimeArgs === undefined ? [DEFAULT_RUNTIME_BIN, resolveFile(values.config, '--config', DEFAULT_CONFIG)] : runtimeArgs
  const env = resolveEnv(values['forward-env'])
  env.DSH_SESSION_ROOT = sessionRoot
  const maxTokens = values['max-tokens'] === undefined ? undefined : parsePositiveInteger('max-tokens', values['max-tokens'])
  const request: RunnerRequest = {
    task,
    cwd,
    command,
    args,
    env,
    sessionRoot,
    provider: values.provider ?? 'deepseek-official',
    model: values.model ?? 'deepseek-v4-flash',
    ...(maxTokens === undefined ? {} : { maxTokens }),
    timeoutMs: parsePositiveInteger('timeout-ms', values['timeout-ms'], DEFAULT_TIMEOUT_MS),
    shutdownTimeoutMs: parsePositiveInteger('shutdown-timeout-ms', values['shutdown-timeout-ms'], 1_000),
    disposeEofGraceMs: parsePositiveInteger('dispose-eof-grace-ms', values['dispose-eof-grace-ms'], 6_000),
    disposeGraceMs: parsePositiveInteger('dispose-grace-ms', values['dispose-grace-ms'], 3_000),
    progress: values.quiet !== true,
    progressIntervalMs: parsePositiveInteger('progress-ms', values['progress-ms'], 15_000),
  }
  return { help: false, request }
}

function gitStatus(cwd: string): { available: boolean; entries: GitStatusEntry[]; detail?: string } {
  const result = spawnSync('git', gitArgs(cwd, ['status', '--porcelain=v1', '-z']), { cwd, encoding: 'utf8', windowsHide: true })
  if (result.error !== undefined) return { available: false, entries: [], detail: result.error.message }
  if (result.status !== 0) return { available: false, entries: [], detail: result.stderr.trim() || `git exited ${result.status}` }
  const entries: GitStatusEntry[] = []
  for (const token of result.stdout.split('\0')) {
    if (token === '') continue
    if (token.length < 4) continue
    entries.push({ status: token.slice(0, 2), path: token.slice(3) })
    if (entries.length === MAX_CAPTURED_STATUS_LINES) break
  }
  return { available: true, entries }
}

/** Return paths whose status entry appeared, disappeared, or changed. */
export function changedGitPaths(before: readonly GitStatusEntry[], after: readonly GitStatusEntry[]): string[] {
  const beforeStates = new Map(before.map(entry => [entry.path, entry.status]))
  const afterStates = new Map(after.map(entry => [entry.path, entry.status]))
  const paths = new Set([...beforeStates.keys(), ...afterStates.keys()])
  return [...paths].filter(path => beforeStates.get(path) !== afterStates.get(path)).sort()
}

function gitDiffCheck(cwd: string): CheckResult {
  const result = spawnSync('git', gitArgs(cwd, ['diff', '--check']), { cwd, encoding: 'utf8', windowsHide: true })
  if (result.error !== undefined) return { status: 'unavailable', detail: result.error.message }
  if (result.status === 0) return { status: 'passed' }
  return { status: 'failed', detail: result.stdout.trim() || result.stderr.trim() || `git exited ${result.status}` }
}

function gitArgs(cwd: string, args: readonly string[]): string[] {
  // Keep the ownership exception process-local; the runner must not modify the user's Git config.
  return ['-c', `safe.directory=${cwd.replaceAll('\\', '/')}`, ...args]
}

function workspaceEvidence(cwd: string, before: ReturnType<typeof gitStatus>): WorkspaceEvidence {
  const after = gitStatus(cwd)
  return {
    gitAvailable: before.available && after.available,
    before: before.entries,
    after: after.entries,
    changedPaths: before.available && after.available ? changedGitPaths(before.entries, after.entries) : [],
    diffCheck: before.available && after.available ? gitDiffCheck(cwd) : { status: 'unavailable', detail: 'git status was unavailable' },
  }
}

function assistantText(notifications: readonly HarnessNotification[]): string {
  for (let index = notifications.length - 1; index >= 0; index--) {
    const notification = notifications[index]
    if (notification?.method !== 'session.event') continue
    const event = notification.params.event
    if (!isRecord(event) || event.type !== 'assistant/message' || !isRecord(event.data)) continue
    const message = event.data.message
    if (!isRecord(message) || !Array.isArray(message.content)) continue
    return message.content
      .filter((block): block is { type: 'text'; text: string } => isRecord(block) && block.type === 'text' && typeof block.text === 'string')
      .map(block => block.text)
      .join('')
  }
  return ''
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function stopReason(result: RunResult): string | undefined {
  for (let index = result.events.length - 1; index >= 0; index--) {
    const event = result.events[index]
    if (event?.type === 'turn/end') return event.data.reason.kind
  }
  return undefined
}

function classifyError(error: unknown): { status: RunnerStatus; name: string; message: string } {
  if (error instanceof RequestTimeoutError) return { status: 'failed', name: error.name, message: error.message }
  if (error instanceof SdkProtocolError || error instanceof JsonRpcResponseError) return { status: 'failed', name: error.name, message: error.message }
  if (error instanceof TransportClosedError) return { status: 'failed', name: error.name, message: error.message }
  if (error instanceof Error) return { status: 'failed', name: error.name, message: error.message }
  return { status: 'failed', name: 'UnknownError', message: String(error) }
}

function statusFromReason(reason: string | undefined): RunnerStatus {
  switch (reason) {
    case 'completed': return 'completed'
    case 'max-tokens': return 'max-tokens'
    case 'aborted': return 'aborted'
    default: return 'failed'
  }
}

interface RunnerHarness {
  run(input: string, options: { onNotification: (notification: HarnessNotification) => void }): Promise<RunResult>
  close(): Promise<void>
}

type HarnessFactory = (request: RunnerRequest, onRequest?: JsonRpcRequestHandler) => RunnerHarness

function defaultHarness(request: RunnerRequest, onRequest?: JsonRpcRequestHandler): RunnerHarness {
  return new DeepSeekHarness({
    launch: {
      command: request.command,
      args: [...request.args],
      cwd: request.cwd,
      env: { ...request.env },
      shutdownTimeoutMs: request.shutdownTimeoutMs,
      disposeEofGraceMs: request.disposeEofGraceMs,
      disposeGraceMs: request.disposeGraceMs,
      ...(onRequest === undefined ? {} : { onRequest }),
    },
    cwd: request.cwd,
    provider: request.provider,
    model: request.model,
    ...request.maxTokens === undefined ? {} : { maxTokens: request.maxTokens },
  })
}

function interactionRequestHandler(
  handler: RunnerInteractionHandler,
  report: (event: Omit<RunnerProgressEvent, 'schemaVersion' | 'type' | 'elapsedMs'>) => void,
): JsonRpcRequestHandler {
  return async (method, params) => {
    if (method !== 'interaction/request') throw new Error(`unsupported child request method: ${method}`)
    const request = parseInteractionRequest(params)
    report({ phase: 'interaction', message: 'caller decision required', method, interaction: request })
    return parseInteractionResponse(await handler(request), request)
  }
}

interface StdinInteractionPolicy {
  readonly handler: RunnerInteractionHandler
  close(): void
}

function createStdinInteractionPolicy(): StdinInteractionPolicy {
  let reader: Interface | undefined
  let closed = false
  let failure: Error | undefined
  const buffered = new Map<string, unknown>()
  const waiters = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }[]>()

  const fail = (error: Error): void => {
    failure ??= error
    for (const requests of waiters.values()) {
      for (const waiter of requests) waiter.reject(failure)
    }
    waiters.clear()
  }
  const start = (): void => {
    if (reader !== undefined) return
    reader = createInterface({ input: process.stdin })
    reader.on('line', (line) => {
      if (line.trim() === '') return
      let value: unknown
      try {
        value = JSON.parse(line)
      } catch (error) {
        fail(new Error(`invalid interaction answer JSON: ${error instanceof Error ? error.message : String(error)}`))
        return
      }
      if (!isRecord(value) || typeof value.requestId !== 'string') {
        fail(new Error('interaction answer must contain a string requestId'))
        return
      }
      const requests = waiters.get(value.requestId)
      const waiter = requests?.shift()
      if (requests?.length === 0) waiters.delete(value.requestId)
      if (waiter !== undefined) waiter.resolve(value)
      else buffered.set(value.requestId, value)
    })
    reader.on('close', () => {
      closed = true
      fail(new Error('runner stdin closed before the interaction answer arrived'))
    })
  }

  const handler: RunnerInteractionHandler = async (request) => {
    start()
    if (failure !== undefined) throw failure
    const queued = buffered.get(request.requestId)
    if (queued !== undefined) {
      buffered.delete(request.requestId)
      return parseInteractionResponse(queued, request)
    }
    if (closed) throw new Error('runner stdin closed before the interaction answer arrived')
    const value = await new Promise<unknown>((resolveValue, reject) => {
      const requests = waiters.get(request.requestId) ?? []
      requests.push({ resolve: resolveValue, reject })
      waiters.set(request.requestId, requests)
    })
    return parseInteractionResponse(value, request)
  }

  return {
    handler,
    close: () => {
      closed = true
      reader?.close()
      fail(new Error('runner interaction policy closed'))
    },
  }
}

function errorObject(error: { name: string; message: string }): { name: string; message: string } {
  return { name: error.name, message: error.message }
}

function writeProgress(event: RunnerProgressEvent): void {
  process.stderr.write(`${JSON.stringify(event)}\n`)
}

function notificationProgress(notification: HarnessNotification): Omit<RunnerProgressEvent, 'schemaVersion' | 'type' | 'elapsedMs'> | undefined {
  if (notification.method === 'session.status') {
    const status = notification.params.status
    if (typeof status !== 'string') return undefined
    return { phase: 'activity', message: `session ${status}`, method: notification.method }
  }
  if (notification.method === 'subagent.started' || notification.method === 'subagent.finished') {
    return { phase: 'activity', message: notification.method, method: notification.method }
  }
  if (notification.method !== 'session.event') return undefined
  const event = notification.params.event
  if (!isRecord(event) || typeof event.type !== 'string') return undefined
  const data = isRecord(event.data) ? event.data : undefined
  const turn = data !== undefined && typeof data.turn === 'number' ? `turn ${data.turn}` : 'turn'
  const toolName = data !== undefined && typeof data.name === 'string' ? data.name : 'tool'
  if (event.type === 'turn/start') return { phase: 'activity', message: `${turn} started`, method: notification.method, eventType: event.type }
  if (event.type === 'turn/end') {
    const reason = data !== undefined && isRecord(data.reason) && typeof data.reason.kind === 'string' ? ` (${data.reason.kind})` : ''
    return { phase: 'activity', message: `${turn} ended${reason}`, method: notification.method, eventType: event.type }
  }
  if (event.type === 'tool/call') return { phase: 'activity', message: `${toolName} started`, method: notification.method, eventType: event.type }
  if (event.type === 'tool/result') return { phase: 'activity', message: `${toolName} finished`, method: notification.method, eventType: event.type }
  if (event.type === 'assistant/message') return { phase: 'activity', message: 'assistant message received', method: notification.method, eventType: event.type }
  if (event.type === 'agent/inbox/spliced') return { phase: 'activity', message: 'prompt accepted', method: notification.method, eventType: event.type }
  return undefined
}

/** Execute one supervised child run and collect workspace evidence. */
export async function executeRunnerRequest(
  request: RunnerRequest,
  createHarness: HarnessFactory = defaultHarness,
  onProgress?: RunnerProgressSink,
  onInteraction?: RunnerInteractionHandler,
): Promise<RunnerResult> {
  const before = gitStatus(request.cwd)
  const notifications: HarnessNotification[] = []
  let timer: ReturnType<typeof setTimeout> | undefined
  let progressTimer: ReturnType<typeof setInterval> | undefined
  let timedOut = false
  let primaryError: { name: string; message: string } | undefined
  let output = ''
  let status: RunnerStatus = 'failed'
  let reason: string | undefined
  const progressSink = onProgress ?? (request.progress ? writeProgress : undefined)
  const startedAt = Date.now()
  const report = (event: Omit<RunnerProgressEvent, 'schemaVersion' | 'type' | 'elapsedMs'>): void => {
    progressSink?.({ schemaVersion: 1, type: 'progress', elapsedMs: Date.now() - startedAt, ...event })
  }
  const childRequestHandler = onInteraction === undefined ? undefined : interactionRequestHandler(onInteraction, report)
  const harness = createHarness(request, childRequestHandler)
  report({ phase: 'started', message: 'child run started', provider: request.provider, model: request.model })
  if (progressSink !== undefined) {
    progressTimer = setInterval(() => { report({ phase: 'heartbeat', message: 'child run still active' }) }, request.progressIntervalMs)
  }

  try {
    const run = harness.run(request.task, { onNotification: (notification) => {
      notifications.push(notification)
      const progress = notificationProgress(notification)
      if (progress !== undefined) report(progress)
    } })
    const outcome = await Promise.race([
      run.then(value => ({ kind: 'run' as const, value })),
      new Promise<{ kind: 'timeout' }>((resolveTimeout) => {
        timer = setTimeout(() => { resolveTimeout({ kind: 'timeout' }) }, request.timeoutMs)
      }),
    ])
    if (outcome.kind === 'timeout') {
      timedOut = true
      primaryError = { name: 'RunnerTimeoutError', message: `child run exceeded ${request.timeoutMs} ms` }
      await harness.close()
      await run.catch(() => undefined)
    } else {
      output = outcome.value.finalResponse
      reason = stopReason(outcome.value)
      status = statusFromReason(reason)
    }
  } catch (error: unknown) {
    const classified = classifyError(error)
    primaryError = errorObject(classified)
    output = assistantText(notifications)
    status = classified.status
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    if (progressTimer !== undefined) clearInterval(progressTimer)
    try {
      await harness.close()
    } catch (error: unknown) {
      if (primaryError === undefined) primaryError = errorObject(classifyError(error))
    }
  }

  if (timedOut) status = 'timed-out'
  const result: RunnerResult = {
    schemaVersion: 1,
    status,
    ...(reason === undefined ? {} : { stopReason: reason }),
    output,
    request: {
      cwd: request.cwd,
      command: request.command,
      args: request.args,
      provider: request.provider,
      model: request.model,
      timeoutMs: request.timeoutMs,
    },
    evidence: workspaceEvidence(request.cwd, before),
    ...(primaryError === undefined ? {} : { error: primaryError }),
  }
  report({ phase: 'finished', message: `child run ${result.status}`, resultStatus: result.status, ...(reason === undefined ? {} : { stopReason: reason }) })
  return result
}

/** Execute the command-line runner and return its process exit code. */
export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  let stdinPolicy: StdinInteractionPolicy | undefined
  try {
    const invocation = parseRunnerArgs(argv)
    if (invocation.help) {
      process.stdout.write(`${RUNNER_USAGE}\n`)
      return 0
    }
    stdinPolicy = createStdinInteractionPolicy()
    const result = await executeRunnerRequest(invocation.request as RunnerRequest, undefined, undefined, stdinPolicy.handler)
    process.stdout.write(`${JSON.stringify(result)}\n`)
    return result.status === 'completed' || result.status === 'max-tokens' ? 0 : 1
  } catch (error: unknown) {
    const failure = error instanceof Error ? error : new Error(String(error))
    process.stderr.write(`dsh-subagent-runner: ${failure.message}\n${RUNNER_USAGE}\n`)
    return 2
  } finally {
    stdinPolicy?.close()
  }
}

const entry = process.argv[1]
if (entry !== undefined && isAbsolute(entry) && resolve(entry) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main()
}
