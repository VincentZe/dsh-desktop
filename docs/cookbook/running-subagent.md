# Run the dsh subagent runner

English | [中文](running-subagent.zh.md)

This cookbook covers the repository-level `pnpm dsh:subagent` command. The command supervises one child task through the dsh SDK JSON-RPC client and keeps progress, the final result, and workspace evidence on separate streams.

## Prerequisites

Run the command from the repository root with Node.js 22.19 or newer and the workspace dependencies installed.

The default JSON-RPC child uses the sandboxed platform shell: `pwsh` on Windows and `bash` on POSIX. The selected shell receives the same permission and approval policy as the filesystem tools.

1. Install dependencies with `pnpm install`.
2. Build the default child runtime with `pnpm run build`.
3. Configure the provider route and credentials in the active dsh home. The child reads the managed settings and credential documents directly; the runner does not inherit credential-shaped environment variables implicitly.

The default child runtime is [`examples/jsonrpc-agent/cordis.yml`](../../examples/jsonrpc-agent/cordis.yml), launched by the built [`@deepseek-ai/dsh-sdk-jsonrpc-demo`](../../packages/examples/jsonrpc-demo/README.md) entry point.

## Run one task

Pass one positional task or use `--task`. The provider and model travel together to the child runtime, so specify both when the deployment has more than one route.

```sh
pnpm dsh:subagent -- "inspect the workspace and report actionable findings"
pnpm dsh:subagent --provider vocano --model deepseek-v4-flash-ga -- "review the changed files"
```

The second command requires a configured `vocano` route and a model entry whose id or unique display name resolves to `deepseek-v4-flash-ga`. Replace `vocano` with the provider configured for the target model.

When a credential exists only in the parent process environment, forward that named variable explicitly:

```sh
pnpm dsh:subagent --forward-env DEEPSEEK_API_KEY -- "run the requested check"
```

Use `--cwd <path>` to select the child workspace, `--session-root <path>` to select its JSONL persistence root, `--max-tokens <n>` to cap model output, and `--timeout-ms <n>` to bound the whole run. `--cwd` is resolved once and used for the runtime process, session header, filesystem and platform-shell providers, and the model-visible task prefix. The child also receives it as `DSH_CWD`; a custom cordis config should use that variable for workspace-scoped providers.

## Use the background job interface

Code that needs to supervise more than one child can use the in-process `RunnerJobManager` from [`scripts/dsh-subagent-jobs.ts`](../../scripts/dsh-subagent-jobs.ts). `start()` returns a `jobId` immediately; `wait()` long-polls progress by cursor; `respond()` answers a pending structured question; and `cancel()` waits for the child to be reaped.

```ts
declare const manager: {
  start(request: unknown): { jobId: string; cursor: number }
  wait(jobId: string, options: { afterCursor: number; timeoutMs: number }): Promise<{
    status: 'running' | 'waiting-input' | 'completed' | 'max-tokens' | 'aborted' | 'timed-out' | 'failed'
    nextCursor: number
    pendingInteraction?: unknown
  }>
  respond(jobId: string, answer: unknown): void
}
declare const request: unknown
declare function chooseAnswer(interaction: unknown): unknown

async function supervise(): Promise<void> {
  const started = manager.start(request)
  let cursor = started.cursor
  for (;;) {
    const snapshot = await manager.wait(started.jobId, { afterCursor: cursor, timeoutMs: 30_000 })
    cursor = snapshot.nextCursor
    if (snapshot.pendingInteraction !== undefined) {
      manager.respond(started.jobId, chooseAnswer(snapshot.pendingInteraction))
    }
    if (['completed', 'max-tokens', 'aborted', 'timed-out', 'failed'].includes(snapshot.status)) break
  }
}

void supervise()
```

`wait()` returns when a new event arrives, an interaction is pending, the job settles, or its timeout expires. `nextCursor` is the latest cursor, so passing it back prevents duplicate events. Jobs and their terminal results are process-local and remain readable for the lifetime of the manager. The manager itself is not persistent; the stdio adapter below provides process-to-process transport, but neither layer provides durable recovery after the adapter exits.

For a separate parent process such as Codex, start the stdio adapter once:

```powershell
pnpm --silent dsh:subagent-jobs
```

Send newline-delimited JSON-RPC requests. `job/start` accepts the same runner options as an `argv` array and returns immediately; `job/wait` returns the manager snapshot; `job/respond` takes the structured answer under `answer`; and `job/cancel` waits for child teardown. Use `snapshot.status` and `nextCursor` as the authoritative lifecycle fields.

```json
{"jsonrpc":"2.0","id":1,"method":"job/start","params":{"argv":["--cwd","D:\\path\\to\\repo","--provider","vocano","--model","deepseek-v4-flash-ga","--permission","read-only","--task","Review the repository and report findings."]}}
```

## Set child permissions

The default child uses `workspace-write` with `ask`: file mutations stay inside the session workspace and permitted temporary directories, and a model-requested wider sandbox is handled by the approval policy. The caller selects this policy at launch, and it applies to the child session created by that runner:

```sh
pnpm dsh:subagent --permission read-only -- "inspect the repository without changing files"
pnpm dsh:subagent --permission workspace-write --approval ask -- "implement the requested fix"
pnpm dsh:subagent --permission danger-full-access --approval never -- "run the isolated migration"
```

`--permission` accepts `read-only`, `workspace-write`, or `danger-full-access`; `--approval` accepts `ask` or `never`. When `--approval` is omitted, the first two permissions use `ask` and `danger-full-access` uses `never`. The default JSON-RPC composition consumes `DSH_PERMISSION_MODE` and `DSH_APPROVAL_POLICY` through the shared sandbox and approval plugins. The JSON-RPC runtime has no human approval UI, so an escalation with no configured answerer is rejected. With `--config`, a custom composition must consume these environment variables and mount the corresponding sandbox and approval providers; the runner does not rewrite the plugin composition.

## Group the child in the Web UI

Use `--workspace-path <path>` to idempotently find or create a Web workspace and attach the settled child session to it:

```sh
pnpm dsh:subagent --cwd D:\path\to\repo --workspace-path D:\path\to\repo --web-url http://127.0.0.1:3080 -- "review the repository"
```

Use `--workspace-id <id>` when the Web workspace already has a stable id. `--no-workspace` explicitly disables either binding option. The runner calls the Web host only after the child has settled, so it does not resume or attach a live session while the child is writing its log. The default Web URL is `http://127.0.0.1:3080`, or `DSH_WEB_URL` when set.

Path binding is best-effort when it uses the default URL and that host is unavailable: stdout reports `workspace.status: "skipped"` and the child result remains usable. An explicit Web URL or a Web API business error reports `workspace.status: "failed"`. The Web host must use the same `--session-root` as the runner to observe the child session.

## Read the streams

The runner writes exactly one final JSON object to stdout. It includes `status`, the final `output`, the resolved `request`, and `evidence` containing Git before/after state, changed paths, and `git diff --check`; failures add an `error` object.

Progress is newline-delimited JSON on stderr. Its phases are `started`, `activity`, `heartbeat`, `interaction`, and `finished`. Progress carries lifecycle facts such as the provider, model, session activity, tool names, and stop status, but does not carry the task text, model text, or tool arguments. A failed `tool/result` adds `toolName` and a bounded `toolError` summary with the available error name, code, and normalized message; it does not include the call id or full tool result. Use `--quiet` to disable it or `--progress-ms <n>` to change the idle heartbeat interval.

The process exits with code `0` for `completed` and `max-tokens` when workspace binding is not failed, code `1` for child failure, timeout, abort, or an explicit workspace binding failure, and code `2` for invalid runner arguments. A nonzero exit does not make stdout unusable: an accepted child failure or timeout still produces the structured result JSON.

## Answer questions

The child can request a structured answer through `ask_user_question`. The runner emits a progress record with `phase: "interaction"` and the complete `interaction` request on stderr. The caller decides the policy and writes one JSON answer line to the runner's stdin, echoing the request id:

```json
{"requestId":"...","answers":[{"id":"mode","selected":["fast"]}]}
```

Use question ids and option labels from the request. The protocol rejects an unknown question id, an option that was not offered, duplicate answers, and multiple selections for a single-select question. Omitting a question from `answers` leaves it skipped. This path is caller-controlled and does not open a human-facing prompt automatically.

## Share sessions

The runner sets the child `DSH_SESSION_ROOT` to `$DSH_HOME/sessions` by default. A Web host using the same persistence root can list and observe the child session as read-only history; it does not attach to, resume, or mark the child as running. Pass the same explicit path with `--session-root` when the host uses a different root. Workspace binding adds durable Web grouping after the run; it does not change the child session log.

The runner is a repository script, not a Cordis plugin. Use `--config` to replace the default child composition. Use repeatable `--runtime-arg` values to launch another compatible JSON-RPC runtime; when `--runtime-arg` is present, it cannot be combined with `--config`. The full option parser is maintained in [`scripts/dsh-subagent-runner.ts`](../../scripts/dsh-subagent-runner.ts).
