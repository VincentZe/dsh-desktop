# Agent Note: Runner background job interface

Status: implemented

English | [中文](2026-08-17-runner-background-job-interface.zh.md)

## Problem

The one-shot runner made a caller wait on the child process and exposed progress only through stderr. A host adapter therefore could not start several child tasks, resume polling later, answer an interaction independently, or cancel one task by stable id.

## Decision

`RunnerJobManager` owns process-local child jobs with four operations: `start()` returns a job id and cursor immediately, `wait()` long-polls progress after a cursor, `respond()` validates and releases the current interaction request, and `cancel()` aborts the runner and waits for child teardown. Each progress event receives a monotonically increasing job-local cursor. Terminal jobs retain their result for the manager lifetime.

`executeRunnerRequest()` accepts an optional `AbortSignal`. Cancellation closes the SDK harness through its existing process-disposal ladder and reports `aborted`; it does not add a wire-level cancel method. The manager is an in-process API. `scripts/dsh-subagent-jobs-server.ts` exposes the same lifecycle through a long-lived newline-delimited JSON-RPC stdio adapter with `job/start`, `job/wait`, `job/respond`, `job/cancel`, and `job/shutdown`; it reuses the runner argv parser so model, workspace, permission, and approval selection stay consistent with the one-shot CLI.

## Alternatives considered

**Turn the CLI into a daemon first.** This would require a process ownership and restart protocol before the lifecycle semantics were stable, and would break the existing one-shot command boundary.

**Reuse the existing `packages/jobs` service.** That service is scoped to dsh agent ownership and session fences inside a Cordis runtime; it is not the owner of an external SDK child process.

**Add cancellation to the SDK wire protocol.** The current client already has bounded child teardown through `close()`, while a wire cancel request would need runtime-side state and persistence rules. The runner can provide useful cancellation without widening the shared protocol.

## Consequences

Callers can supervise several tasks with bounded long polls and can handle structured questions without blocking a foreground CLI. A parent process can keep one stdio adapter alive and persist each `jobId` with its latest cursor. Job ids and event history still disappear when that adapter exits; there is no retention limit or cross-process recovery, so a durable adapter must define those rules before exposing ids beyond the adapter lifetime.
