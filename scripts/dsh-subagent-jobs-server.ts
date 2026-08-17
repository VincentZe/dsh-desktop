#!/usr/bin/env node
/**
 * JSON-RPC stdio adapter for the process-local runner job manager.
 *
 * The wire accepts runner CLI argv for `job/start`, so permission, workspace,
 * model, and environment policy keep one parser. The manager remains the
 * lifecycle owner; this file only translates requests and responses.
 *
 * @module dsh-subagent-jobs-server
 */

import { isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Readable, Writable } from 'node:stream'
import { JsonRpcLineTransport } from '@deepseek-ai/dsh-sdk-protocol'
import {
  RunnerJobManager,
  type RunnerJobManager as RunnerJobManagerType,
  type RunnerJobWaitOptions,
} from './dsh-subagent-jobs.ts'
import { parseRunnerArgs, type RunnerInteractionAnswer, type RunnerInvocation } from './dsh-subagent-runner.ts'

/** JSON-RPC method names exposed by this adapter. */
export type RunnerJobRpcMethod = 'job/start' | 'job/wait' | 'job/respond' | 'job/cancel' | 'job/shutdown'

/** Options for embedding the JSON-RPC adapter in a test or host process. */
export interface RunnerJobRpcServerOptions {
  readonly manager?: RunnerJobManagerType
  /** Called after a `job/shutdown` response has been scheduled. */
  readonly onShutdown?: () => void
}

/** A running stdio adapter and its process-local job manager. */
export interface RunnerJobRpcServer {
  readonly manager: RunnerJobManagerType
  readonly transport: JsonRpcLineTransport
  close(): Promise<void>
}

/**
 * Attach the runner job protocol to caller-owned streams.
 * @param input - newline-delimited JSON-RPC request stream.
 * @param output - newline-delimited JSON-RPC response stream.
 * @param options - optional manager and shutdown callback.
 * @returns the adapter and its lifecycle controls.
 */
export function createRunnerJobRpcServer(
  input: Readable,
  output: Writable,
  options: RunnerJobRpcServerOptions = {},
): RunnerJobRpcServer {
  const manager = options.manager ?? new RunnerJobManager()
  const transport = new JsonRpcLineTransport(input, output)
  let closeTask: Promise<void> | undefined
  const close = (): Promise<void> => {
    closeTask ??= manager.cancelAll().finally(() => { transport.close() })
    return closeTask
  }
  const handleRequest = async (method: string, params: Record<string, unknown>): Promise<unknown> => {
    switch (method) {
      case 'job/start': {
        const invocation = parseInvocation(params)
        if (invocation.help || invocation.request === undefined) throw new TypeError('job/start requires a task')
        return manager.start(invocation.request)
      }
      case 'job/wait': {
        const jobId = requiredString(params, 'jobId')
        return manager.wait(jobId, waitOptions(params))
      }
      case 'job/respond': {
        const jobId = requiredString(params, 'jobId')
        const answer = params.answer
        if (!isRecord(answer)) throw new TypeError('job/respond answer must be an object')
        manager.respond(jobId, answer as unknown as RunnerInteractionAnswer)
        return {}
      }
      case 'job/cancel': {
        const jobId = requiredString(params, 'jobId')
        await manager.cancel(jobId)
        return {}
      }
      case 'job/shutdown': {
        await manager.cancelAll()
        if (options.onShutdown !== undefined) setImmediate(options.onShutdown)
        return {}
      }
      default:
        throw new Error(`unknown runner job method: ${method}`)
    }
  }
  transport.onRequest(handleRequest)
  transport.start()
  return { manager, transport, close }
}

function parseInvocation(params: Record<string, unknown>): RunnerInvocation {
  const rawArgv = params.argv
  if (!Array.isArray(rawArgv) || !rawArgv.every(value => typeof value === 'string')) {
    throw new TypeError('job/start argv must be an array of strings')
  }
  return parseRunnerArgs(rawArgv)
}

function waitOptions(params: Record<string, unknown>): RunnerJobWaitOptions {
  const options: { afterCursor?: number; timeoutMs?: number } = {}
  if (params.afterCursor !== undefined) options.afterCursor = integer(params.afterCursor, 'afterCursor')
  if (params.timeoutMs !== undefined) options.timeoutMs = integer(params.timeoutMs, 'timeoutMs')
  return options
}

function requiredString(params: Record<string, unknown>, key: string): string {
  const value = params[key]
  if (typeof value !== 'string' || value === '') throw new TypeError(`${key} must be a non-empty string`)
  return value
}

function integer(value: unknown, key: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${key} must be a non-negative safe integer`)
  }
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Start the stdio server used by `pnpm --silent dsh:subagent-jobs`. */
export async function main(): Promise<number> {
  let stopping = false
  const server = createRunnerJobRpcServer(process.stdin, process.stdout, { onShutdown: () => { stop(0) } })
  const stop = (code: number): void => {
    if (stopping) return
    stopping = true
    void server.close().then(() => { process.exit(code) })
  }
  process.stdin.once('end', () => { stop(0) })
  process.on('SIGTERM', () => { stop(0) })
  process.on('SIGINT', () => { stop(130) })
  await new Promise<void>(() => {})
  return 0
}

const entry = process.argv[1]
if (entry !== undefined && isAbsolute(entry) && resolve(entry) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main()
}
