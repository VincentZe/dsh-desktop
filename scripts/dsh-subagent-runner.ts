#!/usr/bin/env node
/**
 * Supervises one out-of-process DeepSeek Harness task through the SDK client.
 * The runner owns the caller-facing JSON result, bounded teardown, and
 * workspace evidence; the child runtime owns the agent composition.
 *
 * @module dsh-subagent-runner
 */

import { existsSync, statSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { createInterface, type Interface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { delimiter, dirname, isAbsolute, resolve } from 'node:path'
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
const DEFAULT_WEB_URL = 'http://127.0.0.1:3080'
const DEFAULT_PERMISSION: RunnerPermission = 'workspace-write'
const DEFAULT_APPROVAL: RunnerApproval = 'ask'
const WORKSPACE_API_TIMEOUT_MS = 10_000
const MAX_CAPTURED_STATUS_LINES = 400
const MAX_PROGRESS_TOOL_NAME_CHARS = 80
const MAX_PROGRESS_ERROR_CHARS = 240
const MAX_PROGRESS_TEXT_DEPTH = 4

/** Stable result statuses emitted by the runner. */
export type RunnerStatus = 'completed' | 'max-tokens' | 'aborted' | 'timed-out' | 'failed'

/** File-access policy applied by the default child runtime. */
export type RunnerPermission = 'read-only' | 'workspace-write' | 'danger-full-access'

/** Approval policy applied by the default child runtime. */
export type RunnerApproval = 'ask' | 'never'

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
  readonly permission: RunnerPermission
  readonly approval: RunnerApproval
  readonly maxTokens?: number
  readonly timeoutMs: number
  readonly shutdownTimeoutMs: number
  readonly disposeEofGraceMs: number
  readonly disposeGraceMs: number
  readonly progress: boolean
  readonly progressIntervalMs: number
  readonly workspace?: RunnerWorkspaceRequest
}

/** Web-host workspace selection requested for one child run. */
export type RunnerWorkspaceRequest =
  | { readonly mode: 'id'; readonly workspaceId: string; readonly webUrl: string }
  | { readonly mode: 'path'; readonly path: string; readonly webUrl: string; readonly fallbackIfUnavailable: boolean }

/** Result of the optional Web-host workspace binding. */
export interface RunnerWorkspaceResult {
  readonly status: 'not-requested' | 'bound' | 'skipped' | 'failed'
  readonly mode?: 'id' | 'path'
  readonly workspaceId?: string
  readonly sessionId?: string
  readonly path?: string
  readonly webUrl?: string
  readonly created?: boolean
  readonly reason?: string
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
    readonly permission: RunnerPermission
    readonly approval: RunnerApproval
    readonly timeoutMs: number
    readonly workspace?: RunnerWorkspaceRequest
  }
  readonly workspace: RunnerWorkspaceResult
  readonly evidence: WorkspaceEvidence
  readonly error?: RunnerErrorSummary
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
  readonly toolName?: string
  readonly toolError?: RunnerToolErrorSummary
  readonly resultStatus?: RunnerStatus
  readonly stopReason?: string
  readonly workspaceStatus?: RunnerWorkspaceResult['status']
  readonly interaction?: RunnerInteractionRequest
}

/** Bounded failure details for one model-requested tool call. */
export interface RunnerToolErrorSummary {
  readonly name?: string
  readonly code?: string
  readonly message: string
}

/** Bounded failure details for a child turn that settled with `reason: error`. */
export interface RunnerErrorSummary {
  readonly name: string
  readonly message: string
  readonly code?: string
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
  --workspace-id <id>           bind the child session to an existing Web workspace
  --workspace-path <path>       find or create a Web workspace for this directory
  --no-workspace                disable workspace binding even when another flag is present
  --web-url <url>               dsh Web host URL (default: http://127.0.0.1:3080)
  --session-root <path>         shared JSONL session root (default: $DSH_HOME/sessions)
  --config <path>               child cordis.yml for the default runtime
  --command <path>              child command (default: current Node.js)
  --runtime-arg <arg>           replace default runtime arguments (repeatable)
  --provider <name>             child model provider (default: deepseek-official)
  --model <name>                child model (default: deepseek-v4-flash)
  --permission <mode>           file access: read-only, workspace-write, or danger-full-access (default: workspace-write)
  --approval <policy>           escalation approval: ask or never (default: ask; danger-full-access defaults to never)
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

function parseChoice<T extends string>(name: string, raw: string | undefined, choices: readonly T[], defaultValue: T): T {
  const value = raw ?? defaultValue
  if ((choices as readonly string[]).includes(value)) return value as T
  throw new RunnerUsageError(`--${name} must be one of: ${choices.join(', ')}`)
}

function defaultApprovalFor(permission: RunnerPermission): RunnerApproval {
  return permission === 'danger-full-access' ? 'never' : DEFAULT_APPROVAL
}

function resolveWebUrl(raw: string | undefined): string {
  const value = raw ?? process.env.DSH_WEB_URL ?? DEFAULT_WEB_URL
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new RunnerUsageError(`--web-url must be an absolute http(s) URL: ${value}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new RunnerUsageError(`--web-url must use http or https: ${value}`)
  }
  url.pathname = url.pathname.replace(/\/+$/, '')
  url.search = ''
  url.hash = ''
  return url.toString().replace(/\/$/, '')
}

function resolveEnv(names: readonly string[] | undefined): Record<string, string> {
  const env = scrubbedParentEnv()
  ensureWindowsGitBashOnPath(env)
  for (const name of names ?? []) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new RunnerUsageError(`--forward-env has an invalid name: ${name}`)
    const value = process.env[name]
    if (value !== undefined) env[name] = value
  }
  return env
}

function ensureWindowsGitBashOnPath(env: Record<string, string>): void {
  if (process.platform !== 'win32') return
  const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path') ?? 'PATH'
  const bashProbe = spawnSync('where.exe', ['bash'], { env, encoding: 'utf8', windowsHide: true })
  if (bashProbe.status === 0) return
  const gitProbe = spawnSync('where.exe', ['git'], { env, encoding: 'utf8', windowsHide: true })
  if (gitProbe.status !== 0 || gitProbe.error !== undefined) return
  for (const rawPath of gitProbe.stdout.split(/\r?\n/)) {
    const gitPath = rawPath.trim()
    if (!isAbsolute(gitPath)) continue
    const gitBashBin = resolve(dirname(gitPath), '..', 'bin')
    if (!existsSync(resolve(gitBashBin, 'bash.exe'))) continue
    env[pathKey] = [gitBashBin, env[pathKey]].filter(value => value !== undefined && value !== '').join(delimiter)
    return
  }
}

/**
 * Add the resolved workspace to the model-visible task without changing the user's task text.
 * @param task - caller-provided task text.
 * @param cwd - resolved absolute workspace path.
 * @returns task text with the workspace instruction prefix.
 */
export function taskWithWorkspace(task: string, cwd: string): string {
  return [
    `Workspace for this task: ${cwd}`,
    'Use this exact absolute path for file and shell operations unless the task explicitly names another path.',
    '',
    'Task:',
    task,
  ].join('\n')
}

/** Parse CLI arguments into one resolved request without starting a process. */
export function parseRunnerArgs(argv: readonly string[]): RunnerInvocation {
  const normalizedArgv = argv[0] === '--' ? argv.slice(1) : argv
  const parsed = parseArgs({
    args: [...normalizedArgv],
    options: {
      task: { type: 'string', short: 't' },
      cwd: { type: 'string' },
      'workspace-id': { type: 'string' },
      'workspace-path': { type: 'string' },
      'no-workspace': { type: 'boolean' },
      'web-url': { type: 'string' },
      'session-root': { type: 'string' },
      config: { type: 'string' },
      command: { type: 'string' },
      'runtime-arg': { type: 'string', multiple: true },
      provider: { type: 'string' },
      model: { type: 'string' },
      permission: { type: 'string' },
      approval: { type: 'string' },
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
  if (values['workspace-id'] !== undefined && values['workspace-path'] !== undefined) {
    throw new RunnerUsageError('--workspace-id cannot be combined with --workspace-path')
  }
  if (values['workspace-id'] !== undefined && values['workspace-id'].trim() === '') {
    throw new RunnerUsageError('--workspace-id must not be empty')
  }
  const command = values.command ?? process.execPath
  if (runtimeArgs === undefined && command !== process.execPath) {
    throw new RunnerUsageError('--command requires --runtime-arg when it is not the current Node.js executable')
  }
  const cwd = resolveDirectory(values.cwd, '--cwd')
  const sessionRoot = resolvePath(values['session-root'], dshHomePath('sessions'))
  const args = runtimeArgs === undefined ? [DEFAULT_RUNTIME_BIN, resolveFile(values.config, '--config', DEFAULT_CONFIG)] : runtimeArgs
  const env = resolveEnv(values['forward-env'])
  const permission = parseChoice('permission', values.permission, ['read-only', 'workspace-write', 'danger-full-access'] as const, DEFAULT_PERMISSION)
  const approval = parseChoice('approval', values.approval, ['ask', 'never'] as const, defaultApprovalFor(permission))
  env.DSH_SESSION_ROOT = sessionRoot
  env.DSH_CWD = cwd
  env.DSH_PERMISSION_MODE = permission
  env.DSH_APPROVAL_POLICY = approval
  const workspace = values['no-workspace'] === true
    ? undefined
    : values['workspace-id'] !== undefined
      ? { mode: 'id' as const, workspaceId: values['workspace-id'], webUrl: resolveWebUrl(values['web-url']) }
      : values['workspace-path'] !== undefined
        ? { mode: 'path' as const, path: resolveDirectory(values['workspace-path'], '--workspace-path'), webUrl: resolveWebUrl(values['web-url']), fallbackIfUnavailable: values['web-url'] === undefined }
        : undefined
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
    permission,
    approval,
    ...(maxTokens === undefined ? {} : { maxTokens }),
    timeoutMs: parsePositiveInteger('timeout-ms', values['timeout-ms'], DEFAULT_TIMEOUT_MS),
    shutdownTimeoutMs: parsePositiveInteger('shutdown-timeout-ms', values['shutdown-timeout-ms'], 1_000),
    disposeEofGraceMs: parsePositiveInteger('dispose-eof-grace-ms', values['dispose-eof-grace-ms'], 6_000),
    disposeGraceMs: parsePositiveInteger('dispose-grace-ms', values['dispose-grace-ms'], 3_000),
    progress: values.quiet !== true,
    progressIntervalMs: parsePositiveInteger('progress-ms', values['progress-ms'], 15_000),
    ...(workspace === undefined ? {} : { workspace }),
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

/** Preserve the structured failure recorded when a child turn reaches an error ending. */
function childTurnError(result: RunResult): RunnerErrorSummary | undefined {
  for (let index = result.events.length - 1; index >= 0; index--) {
    const event = result.events[index]
    if (event?.type !== 'turn/end' || event.data.reason.kind !== 'error') continue
    return {
      name: 'ChildTurnError',
      message: boundedProgressText(event.data.reason.error.message, MAX_PROGRESS_ERROR_CHARS),
      code: event.data.reason.error.code,
    }
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

class WorkspaceHostUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WorkspaceHostUnavailableError'
  }
}

class WorkspaceApiError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WorkspaceApiError'
  }
}

function requiredString(value: Record<string, unknown>, key: string, context: string): string {
  const field = value[key]
  if (typeof field !== 'string' || field === '') throw new WorkspaceApiError(`${context} returned an invalid ${key}`)
  return field
}

function workspaceIdFromResponse(value: unknown): { workspaceId: string; created: boolean } {
  if (!isRecord(value) || !isRecord(value.workspace)) throw new WorkspaceApiError('workspace.create returned no workspace')
  const workspaceId = requiredString(value.workspace, 'workspaceId', 'workspace.create')
  if (typeof value.created !== 'boolean') throw new WorkspaceApiError('workspace.create returned an invalid created flag')
  return { workspaceId, created: value.created }
}

function sessionIdFromResponse(value: unknown): string {
  if (!isRecord(value)) throw new WorkspaceApiError('session.create returned an invalid value')
  return requiredString(value, 'sessionId', 'session.create')
}

async function webApiCall(
  webUrl: string,
  method: string,
  payload: Record<string, string>,
  fetchImpl: typeof fetch,
): Promise<unknown> {
  let response: Response
  try {
    response = await fetchImpl(new URL(`api/${method}`, `${webUrl}/`), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload }),
      signal: AbortSignal.timeout(WORKSPACE_API_TIMEOUT_MS),
    })
  } catch (error: unknown) {
    throw new WorkspaceHostUnavailableError(error instanceof Error ? error.message : String(error))
  }
  if (response.status === 404 || response.status === 502 || response.status === 503) {
    throw new WorkspaceHostUnavailableError(`Web host returned HTTP ${response.status}`)
  }
  if (!response.ok) throw new WorkspaceApiError(`Web host returned HTTP ${response.status}`)

  let body: unknown
  try {
    body = await response.json()
  } catch (error: unknown) {
    throw new WorkspaceApiError(`Web host returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!isRecord(body) || body.type !== 'server-response' || typeof body.rpcId !== 'string' || !isRecord(body.result)) {
    throw new WorkspaceApiError(`Web host returned an invalid ${method} response envelope`)
  }
  if (body.result.ok === true) return body.result.value
  if (body.result.ok === false && isRecord(body.result.error)) {
    const code = typeof body.result.error.code === 'string' ? body.result.error.code : 'unknown'
    const message = typeof body.result.error.message === 'string' ? body.result.error.message : 'request failed'
    throw new WorkspaceApiError(`${method} failed (${code}): ${message}`)
  }
  throw new WorkspaceApiError(`Web host returned an invalid ${method} result`)
}

/** Bind the settled child session to the requested Web workspace. */
export async function bindWorkspaceToSession(
  request: RunnerWorkspaceRequest | undefined,
  sessionId: string | undefined,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<RunnerWorkspaceResult> {
  if (request === undefined) return { status: 'not-requested' }
  const base = {
    mode: request.mode,
    ...(request.mode === 'id' ? { workspaceId: request.workspaceId } : {}),
    webUrl: request.webUrl,
    ...(request.mode === 'path' ? { path: request.path } : {}),
    ...(sessionId === undefined ? {} : { sessionId }),
  }
  if (sessionId === undefined) return { ...base, status: 'failed', reason: 'child session id was not observed' }
  let workspaceId: string | undefined
  let created: boolean | undefined
  try {
    if (request.mode === 'path') {
      const workspace = workspaceIdFromResponse(await webApiCall(
        request.webUrl,
        'workspace.create',
        { path: request.path },
        fetchImpl,
      ))
      workspaceId = workspace.workspaceId
      created = workspace.created
    } else {
      workspaceId = request.workspaceId
    }
    const attachedSessionId = sessionIdFromResponse(await webApiCall(request.webUrl, 'session.create', { sessionId, workspaceId }, fetchImpl))
    if (attachedSessionId !== sessionId) throw new WorkspaceApiError('session.create returned a different session id')
    return { ...base, status: 'bound', workspaceId, ...(created === undefined ? {} : { created }) }
  } catch (error: unknown) {
    if (error instanceof WorkspaceHostUnavailableError && request.mode === 'path' && request.fallbackIfUnavailable) {
      return { ...base, status: 'skipped', reason: `Web host unavailable: ${error.message}` }
    }
    return {
      ...base,
      status: 'failed',
      ...(workspaceId === undefined ? {} : { workspaceId }),
      ...(created === undefined ? {} : { created }),
      reason: error instanceof Error ? error.message : String(error),
    }
  }
}

interface RunnerHarness {
  readonly sessionId?: string
  run(input: string, options: { onNotification: (notification: HarnessNotification) => void }): Promise<RunResult>
  close(): Promise<void>
}

type HarnessFactory = (request: RunnerRequest, onRequest?: JsonRpcRequestHandler) => RunnerHarness

function defaultHarness(request: RunnerRequest, onRequest?: JsonRpcRequestHandler): RunnerHarness {
  const harness = new DeepSeekHarness({
    launch: {
      command: request.command,
      args: [...request.args],
      cwd: request.cwd,
      env: {
        ...request.env,
        DSH_CWD: request.cwd,
        DSH_PERMISSION_MODE: request.permission,
        DSH_APPROVAL_POLICY: request.approval,
      },
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
  const sessionId = `session-${randomUUID().replaceAll('-', '')}`
  return {
    sessionId,
    run: (input, options) => harness.run(input, { ...options, sessionId }),
    close: () => harness.close(),
  }
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

function errorObject(error: { name: string; message: string }): RunnerErrorSummary {
  return { name: error.name, message: error.message }
}

function writeProgress(event: RunnerProgressEvent): void {
  process.stderr.write(`${JSON.stringify(event)}\n`)
}

function boundedProgressText(value: string, limit: number): string {
  const normalized = value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim()
  // Provider errors may inline caller identities in otherwise useful diagnostics.
  const redacted = normalized
    .replace(/("(?:account|tenant|user|request)[_-]?id"\s*:\s*)(?:"[^"]*"|\d+)/gi, '$1"[redacted]"')
    .replace(/\b(account|tenant|user)(\s+(?:id\s*)?[:=#]?\s*\(?)(\d{6,})(\)?)/gi, '$1$2[redacted]$4')
    .replace(/\b(request(?:[_ -]?id)?)(\s*[:=#]\s*)([a-z0-9][a-z0-9._-]{7,})/gi, '$1$2[redacted]')
  return redacted.slice(0, limit)
}

function stringProperty(value: unknown, key: string): string | undefined {
  return isRecord(value) && typeof value[key] === 'string' ? value[key] : undefined
}

function firstText(value: unknown, depth = 0): string | undefined {
  if (depth > MAX_PROGRESS_TEXT_DEPTH) return undefined
  if (Array.isArray(value)) {
    for (const item of value) {
      const text = firstText(item, depth + 1)
      if (text !== undefined) return text
    }
    return undefined
  }
  if (!isRecord(value)) return undefined
  if (typeof value.text === 'string') return value.text
  return firstText(value.content, depth + 1)
}

function hasErrorToolResult(value: unknown): boolean {
  if (!isRecord(value) || !Array.isArray(value.content)) return false
  return value.content.some(block => isRecord(block) && block.type === 'tool-result' && block.isError === true)
}

function summarizeToolError(data: Record<string, unknown> | undefined): RunnerToolErrorSummary | undefined {
  if (data === undefined) return undefined
  const error = isRecord(data.error) ? data.error : undefined
  const message = isRecord(data.message) ? data.message : undefined
  if (error === undefined && !hasErrorToolResult(message)) return undefined
  const text = boundedProgressText(firstText(message?.content) ?? '', MAX_PROGRESS_ERROR_CHARS)
  const name = stringProperty(error, 'name')
  const code = stringProperty(error, 'code')
  return {
    ...(name === undefined ? {} : { name }),
    ...(code === undefined ? {} : { code }),
    message: text || (name === undefined ? 'tool returned an error' : `${name} reported an error`),
  }
}

function toolCallId(data: Record<string, unknown> | undefined): string | undefined {
  const message = isRecord(data?.message) ? data.message : undefined
  const sourceCallId = stringProperty(message?.source, 'callId')
  if (sourceCallId !== undefined) return sourceCallId
  if (Array.isArray(message?.content)) {
    for (const block of message.content) {
      const blockCallId = stringProperty(block, 'toolCallId')
      if (blockCallId !== undefined) return blockCallId
    }
  }
  return stringProperty(data, 'callId')
}

function toolNameKey(notification: HarnessNotification, callId: string): string {
  const sessionId = typeof notification.params.sessionId === 'string' ? notification.params.sessionId : ''
  return `${sessionId}\u0000${callId}`
}

function progressToolName(value: unknown): string {
  if (typeof value !== 'string') return 'tool'
  return boundedProgressText(value, MAX_PROGRESS_TOOL_NAME_CHARS) || 'tool'
}

/** Convert one runtime notification into a safe caller-facing progress record. */
export function notificationProgress(
  notification: HarnessNotification,
  toolNamesByCallId = new Map<string, string>(),
): Omit<RunnerProgressEvent, 'schemaVersion' | 'type' | 'elapsedMs'> | undefined {
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
  if (event.type === 'turn/start') return { phase: 'activity', message: `${turn} started`, method: notification.method, eventType: event.type }
  if (event.type === 'turn/end') {
    const reason = data !== undefined && isRecord(data.reason) && typeof data.reason.kind === 'string' ? ` (${data.reason.kind})` : ''
    return { phase: 'activity', message: `${turn} ended${reason}`, method: notification.method, eventType: event.type }
  }
  if (event.type === 'tool/call') {
    const toolName = progressToolName(data?.name)
    const callId = stringProperty(data, 'callId')
    if (callId !== undefined) toolNamesByCallId.set(toolNameKey(notification, callId), toolName)
    return { phase: 'activity', message: `${toolName} started`, method: notification.method, eventType: event.type, toolName }
  }
  if (event.type === 'tool/result') {
    const callId = toolCallId(data)
    const key = callId === undefined ? undefined : toolNameKey(notification, callId)
    const toolName = progressToolName(key === undefined ? data?.name : toolNamesByCallId.get(key) ?? data?.name)
    if (key !== undefined) toolNamesByCallId.delete(key)
    const toolError = summarizeToolError(data)
    return {
      phase: 'activity',
      message: toolError === undefined ? `${toolName} finished` : `${toolName} failed`,
      method: notification.method,
      eventType: event.type,
      toolName,
      ...(toolError === undefined ? {} : { toolError }),
    }
  }
  if (event.type === 'assistant/message') return { phase: 'activity', message: 'assistant message received', method: notification.method, eventType: event.type }
  if (event.type === 'agent/inbox/spliced') return { phase: 'activity', message: 'prompt accepted', method: notification.method, eventType: event.type }
  return undefined
}

/**
 * Execute one supervised child run and collect workspace evidence.
 * @param request - fully resolved child launch and supervision request.
 * @param createHarness - harness factory, replaced by tests when needed.
 * @param onProgress - optional caller-owned progress sink.
 * @param onInteraction - optional caller-owned interaction policy.
 * @param signal - optional cancellation signal that closes the child harness.
 * @returns the settled child result and workspace evidence.
 */
export async function executeRunnerRequest(
  request: RunnerRequest,
  createHarness: HarnessFactory = defaultHarness,
  onProgress?: RunnerProgressSink,
  onInteraction?: RunnerInteractionHandler,
  signal?: AbortSignal,
): Promise<RunnerResult> {
  const before = gitStatus(request.cwd)
  const notifications: HarnessNotification[] = []
  const toolNamesByCallId = new Map<string, string>()
  let timer: ReturnType<typeof setTimeout> | undefined
  let progressTimer: ReturnType<typeof setInterval> | undefined
  let timedOut = false
  let primaryError: RunnerErrorSummary | undefined
  let output = ''
  let status: RunnerStatus = 'failed'
  let reason: string | undefined
  let abortHandler: (() => void) | undefined
  let abortClose: Promise<void> | undefined
  const progressSink = onProgress ?? (request.progress ? writeProgress : undefined)
  const startedAt = Date.now()
  const report = (event: Omit<RunnerProgressEvent, 'schemaVersion' | 'type' | 'elapsedMs'>): void => {
    progressSink?.({ schemaVersion: 1, type: 'progress', elapsedMs: Date.now() - startedAt, ...event })
  }
  const childRequestHandler = onInteraction === undefined ? undefined : interactionRequestHandler(onInteraction, report)
  const harness = createHarness(request, childRequestHandler)
  let childSessionId: string | undefined
  report({ phase: 'started', message: 'child run started', provider: request.provider, model: request.model })
  if (progressSink !== undefined) {
    progressTimer = setInterval(() => { report({ phase: 'heartbeat', message: 'child run still active' }) }, request.progressIntervalMs)
  }

  try {
    type RunnerOutcome =
      | { readonly kind: 'run'; readonly value: RunResult }
      | { readonly kind: 'timeout' }
      | { readonly kind: 'aborted' }
    const abortPromise = signal === undefined ? undefined : new Promise<RunnerOutcome>((resolveAbort) => {
      const abort = (): void => {
        reason = 'aborted'
        primaryError ??= { name: 'RunnerAbortError', message: 'child run was cancelled' }
        abortClose = harness.close()
        void abortClose.catch(() => undefined)
        resolveAbort({ kind: 'aborted' })
      }
      abortHandler = abort
      if (signal.aborted) abort()
      else signal.addEventListener('abort', abort, { once: true })
    })
    const run = signal?.aborted
      ? undefined
      : harness.run(taskWithWorkspace(request.task, request.cwd), { onNotification: (notification) => {
        notifications.push(notification)
        if (childSessionId === undefined) {
          childSessionId = harness.sessionId
            ?? (typeof notification.params.sessionId === 'string' ? notification.params.sessionId : undefined)
        }
        const progress = notificationProgress(notification, toolNamesByCallId)
        if (progress !== undefined) report(progress)
      } })
    const outcomes: Promise<RunnerOutcome>[] = [
      new Promise<{ kind: 'timeout' }>((resolveTimeout) => {
        timer = setTimeout(() => { resolveTimeout({ kind: 'timeout' }) }, request.timeoutMs)
      }),
    ]
    if (run !== undefined) outcomes.push(run.then(value => ({ kind: 'run' as const, value })))
    if (abortPromise !== undefined) outcomes.push(abortPromise)
    const outcome = await Promise.race(outcomes)
    if (outcome.kind === 'timeout') {
      timedOut = true
      primaryError = { name: 'RunnerTimeoutError', message: `child run exceeded ${request.timeoutMs} ms` }
      await harness.close()
      await run?.catch(() => undefined)
    } else if (outcome.kind === 'aborted') {
      status = 'aborted'
      await abortClose?.catch(() => undefined)
      await run?.catch(() => undefined)
    } else {
      output = outcome.value.finalResponse
      childSessionId = outcome.value.sessionId
      reason = stopReason(outcome.value)
      status = statusFromReason(reason)
      primaryError ??= childTurnError(outcome.value)
    }
  } catch (error: unknown) {
    const classified = classifyError(error)
    primaryError ??= errorObject(classified)
    output = assistantText(notifications)
    status = classified.status
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    if (progressTimer !== undefined) clearInterval(progressTimer)
    if (signal !== undefined && abortHandler !== undefined) signal.removeEventListener('abort', abortHandler)
    try {
      await harness.close()
    } catch (error: unknown) {
      if (primaryError === undefined) primaryError = errorObject(classifyError(error))
    }
  }

  if (timedOut) status = 'timed-out'
  const workspace = await bindWorkspaceToSession(request.workspace, childSessionId)
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
      permission: request.permission,
      approval: request.approval,
      ...(request.workspace === undefined ? {} : { workspace: request.workspace }),
    },
    workspace,
    evidence: workspaceEvidence(request.cwd, before),
    ...(primaryError === undefined ? {} : { error: primaryError }),
  }
  report({ phase: 'finished', message: `child run ${result.status}`, resultStatus: result.status, workspaceStatus: workspace.status, ...(reason === undefined ? {} : { stopReason: reason }) })
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
    return result.status === 'completed' || result.status === 'max-tokens'
      ? result.workspace.status === 'failed' ? 1 : 0
      : 1
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
