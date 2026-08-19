---
name: dsh-subagent
description: Delegate bounded repository tasks to the local DeepSeek Harness subagent runner and supervise its JSON result, progress, session, and interaction protocol. Use when Codex should ask a separate dsh child to inspect, research, implement, review, or validate work in a workspace, especially when the child needs its own harness runtime, model configuration, Windows portable runtime, workspace grouping, or lifecycle supervision.
---

# Run dsh subagent

Use the runner for one bounded child task. The child report is evidence for the parent agent to verify, not proof that the work is correct.

For a parent that needs to supervise the child across multiple turns, use the persistent JSON-RPC job adapter. It owns one process-local `RunnerJobManager` and exposes `job/start`, `job/wait`, `job/respond`, and `job/cancel`. The child follows the skills enabled by its selected Cordis composition; the default JSON-RPC composition used below sets `skills.enabled: false`.

## Common calls

Resolve the dsh-desktop root from the current environment: it is the directory containing `package.json`, the `dsh:subagent` script, and `scripts/dsh-subagent-runner.ts`. Run the commands from that root. Replace `<workspace-root>` with an existing absolute target path and describe the goal, edit permission, success criteria, and checks in the task.

Read-only review:

```powershell
pnpm dsh:subagent --cwd <workspace-root> --permission read-only --approval ask -- "Inspect the target and report actionable findings. Do not edit files."
```

Bounded implementation:

```powershell
pnpm dsh:subagent --cwd <workspace-root> --permission workspace-write --approval ask -- "Implement the requested fix, run focused checks, and report changed files and remaining uncertainty."
```

Explicit unrestricted access:

```powershell
pnpm dsh:subagent --cwd <workspace-root> --permission danger-full-access --approval never -- "Perform the explicitly authorized task and report commands, changes, and checks."
```

Use the configured model and show the settled session in the dsh Web host:

```powershell
pnpm dsh:subagent --cwd <workspace-root> --workspace-path <workspace-root> --provider vocano --model deepseek-v4-flash-ga -- "Review the target and report findings. Do not edit files."
```

Use `--web-url`, `--session-root`, `--workspace-id`, `--timeout-ms`, or `--max-tokens` when the host or run needs non-default values. See `<dsh-desktop-root>\docs\cookbook\running-subagent.md` for the complete option and protocol reference.

## Packaging boundary

This is a host-side Codex skill. A source checkout exposes it under `.agents/skills/dsh-subagent`; a global Codex installation is optional. It is not a dsh child skill. The current `desktop\build\portable` package contains the Web host (`dsh-web.exe`) and its fixed Web runtime, but it does not contain `scripts/dsh-subagent-runner.ts`, the JSON-RPC child runtime, or the source `cordis.yml`. Copying this `SKILL.md` into that package does not make subagent calls available, and `dsh-web.exe` is not a valid replacement for the child JSON-RPC runtime.

Until a release package exposes a stable subagent launcher and ships its child runtime/config, use the source checkout commands above. A future packaged launcher must support both the one-shot runner and the persistent jobs adapter before this skill can switch its examples from `pnpm` to the portable executable.

## Persistent job adapter

Start one long-lived server from `<dsh-desktop-root>` in a PTY:

```powershell
pnpm --silent dsh:subagent-jobs
```

Send newline-delimited JSON-RPC requests. `job/start` takes the same runner options as an argv array and returns immediately:

```json
{"jsonrpc":"2.0","id":1,"method":"job/start","params":{"argv":["--cwd","<workspace-root>","--workspace-path","<workspace-root>","--provider","vocano","--model","deepseek-v4-flash-ga","--permission","read-only","--task","Inspect the target and report findings."]}}
```

Poll with `job/wait` using the returned `jobId` and `cursor`. Set `afterCursor` to the previous response's `nextCursor`; treat `snapshot.status` as authoritative, not the last tool label. On `pendingInteraction`, answer with `job/respond` and the exact request id and offered labels. Use `job/cancel` when the parent no longer needs the child, then wait for its response before starting unrelated work.

## Supervise and verify

- Use a PTY for long runs. Read progress JSONL from stderr; parse the final JSON object from stdout.
- With the persistent adapter, read JSON-RPC responses from stdout and keep the child job id and cursor in the parent state.
- On `phase: "interaction"`, answer stdin with the exact request id, question ids, and offered labels, for example:

  ```json
  {"requestId":"...","answers":[{"id":"mode","selected":["fast"]}]}
  ```

  Decide from the parent task. Grant only explicitly authorized actions; choose the least-privileged safe option for ambiguous or destructive requests.
- Inspect `status`, partial output, evidence, changed paths, and `git diff --check`. Re-run relevant checks in the parent workspace before accepting the result.
- Preserve any `toolError` name, code, and message from progress events as diagnostic evidence; a failed tool call is not a terminal child status. Keep polling until `snapshot.status` reaches a terminal value.
- Keep mutable workspaces isolated. Do not let the child commit or push unless the parent task explicitly requires it.
- Treat lifecycle `status` as authoritative. A final `completed`, `max-tokens`, `aborted`, `timed-out`, or `failed` status ends supervision even when the last activity still names a tool such as `Read`.

## Important details

- Always pass an absolute `--cwd`; the runner uses it for the child process, providers, session header, and model-visible task prefix.
- Pass the same `--workspace-path` and `--session-root` as the dsh Web host when Web visibility matters. Use `--no-workspace` only when ungrouped history is intentional.
- `read-only` is for inspection, `workspace-write` for bounded edits, and `danger-full-access` only for explicit authorization. `--approval ask|never` controls approval handling; it does not change the tool inventory.
- The default runtime consumes `DSH_PERMISSION_MODE` and `DSH_APPROVAL_POLICY`. A custom config must consume those variables and mount matching sandbox and approval providers.
- The default runtime exposes sandboxed `pwsh` on Windows and sandboxed `bash` on POSIX; task commands must use the advertised shell dialect.
- A missing built child entry requires `pnpm run build` in the runner repository. Do not put credentials in task text; use configured dsh settings or explicitly forward an existing environment variable.
- `--workspace-path` is a runner/Web grouping option. It belongs before the task separator and must never be appended to the child command or forwarded to Git, PowerShell, or Bash.
- In the Windows portable fixed Web runtime, the ACL runner is re-entered with the reserved `--dsh-windows-acl-runner` marker. Do not construct `[dsh-web.exe, runner.js, ...]`; Node SEA treats `runner.js` as an ordinary argument, which can leak runner flags such as `--workspace` into the child command.
- If a child reports `unknown option '--workspace'` although its task command has no such argument, first suspect a stale or incorrectly packaged fixed Web runtime. Rebuild the CLI host and portable `dsh-web.exe`, then rerun the exact command before changing the task or stripping arguments.
