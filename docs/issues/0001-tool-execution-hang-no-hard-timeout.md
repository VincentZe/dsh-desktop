# Issue 0001: Tool execution hangs indefinitely when the subprocess tree cannot be terminated

English | [中文](0001-tool-execution-hang-no-hard-timeout.zh.md)

Status: open

## Summary

Shell tools (`tool-bash` / `tool-pwsh`) time out *cooperatively*: the timeout policy only aborts the execution signal and never abandons the tool promise. If the child process tree survives termination (Windows `taskkill /T /F` can fail or miss escaped descendants), `handle.done` never settles, so the tool call never completes: no `tool/result` is persisted, the model never receives the timeout message, and the agent stalls on that step forever. When the session is closed during the stall, crash recovery later synthesizes a `TOOL_OUTCOME_UNKNOWN` ("no result was durably recorded") result.

## Impact

- A single long-running command (e.g. a full-disk recursive search) can leave the agent permanently stalled on one tool step.
- The timeout outcome is neither persisted nor delivered to the model, so the model cannot decide to retry or abandon.
- After the session is interrupted and recovered, the agent does not continue on its own; the user must send a message to drive it.

## Reproduction

1. Run a command long enough to hit the tool timeout while its process tree is hard to kill (full-disk recursion, a process that spawns detached descendants, or one that ignores termination).
2. The tool call never returns; the turn stays open.
3. Close the application; on the next session load, the repair layer injects the `TOOL_OUTCOME_UNKNOWN` result.

## Root cause

- `timeout-policy` (`packages/guard/timeout-policy/src/index.ts`) is cooperative by design — *"without racing or abandoning the tool promise"*. On expiry it only aborts the signal; the wrapper is still `await next()`.
- `pwsh-local` waits on the child unconditionally (`packages/shell/pwsh-local/src/index.ts`, `runArgv`: `const outcome = await handle.done`). There is no independent hard deadline around that wait.
- `spawn.ts` (`packages/subprocess/subprocess-local/src/spawn.ts`) has no Windows process-tree liveness probe: *"Windows has no group-liveness probe; the direct child's exit is the observable boundary"*. `taskkill` outcome is deliberately unchecked, and a surviving descendant keeps the tree "alive" from the watcher's perspective with no way to confirm quiescence.
- The tool-call scheduler (`packages/core/agent-loop/src/tool-calls.ts`) races only the already-started dispatches; there is no overall execution budget that would force a result when a tool never settles.
- Consequences: when `taskkill` fails to reap the tree, `handle.done` → `next()` → `tool/result` all hang, and the timeout information never reaches the model.

## Upstream status (checked 2026-08-20, deepseek-ai/deepseek-harness master, rc.8)

- No direct fix for this issue.
- Upstream added `windows-inspector.ts` and `terminal.ts` (persistent-pty feature branch, node-pty 1.2 beta) but only for the persistent terminal path; the ordinary `spawn` `treeAlive()` for Windows is unchanged.
- The cooperative timeout structure in `timeout-policy` / `pwsh-local` / `spawn.ts` is identical to ours.
- Decision: merge upstream first (planned, rc.5 → rc.8), then address this issue locally.

## Suggested fix direction

1. Add a hard fallback at the tool-execution layer: `Promise.race` the tool settlement against a forced deadline (`timeoutMs` + grace), and persist a `TOOL_TIMEOUT` result even when the child process is still running.
2. After persisting the result, keep terminating the background tree (detached) so it cannot hold resources forever.
3. Make Windows tree termination reliable (Job Object, or process-tree enumeration modeled on upstream `windows-inspector.ts`) so `taskkill` failures cannot strand the caller.
4. Guarantee that a timeout outcome always lands in the session log, eliminating `TOOL_OUTCOME_UNKNOWN` on the recovery path.