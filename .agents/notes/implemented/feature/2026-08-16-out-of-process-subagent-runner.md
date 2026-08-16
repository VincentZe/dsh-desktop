# Agent Note: Out-of-process subagent runner uses the SDK client

Status: implemented

English | [中文](2026-08-16-out-of-process-subagent-runner.zh.md)

## Problem

The repository has a JSON-RPC runtime and an SDK client, but invoking one isolated child task still requires callers to assemble the child command, protocol lifecycle, timeout, teardown, and workspace checks themselves. That leaves the useful subagent path dependent on caller-specific supervision code.

## Decision

The repository provides `pnpm dsh:subagent` through `scripts/dsh-subagent-runner.ts`. The runner launches the built `packages/examples/jsonrpc-demo/lib/bin.js` with `examples/jsonrpc-agent/cordis.yml`, sends one task through `@deepseek-ai/dsh-sdk-client`, bounds the run and child teardown, and emits one versioned JSON result. The result includes the child response, terminal status, request routing, Git status snapshots, changed paths, and `git diff --check`.

The runner emits bounded progress JSON Lines on stderr for startup, selected session/turn/tool activity, idle heartbeats, and final status. It keeps task text, model text, and tool arguments out of progress records; stdout remains reserved for the final result JSON so an agent-side wrapper can observe a running child and parse its completion independently.

The default JSON-RPC composition loads `dsh-user-questions` and `dsh-tool-ask-user`. It also mounts the file-backed settings and credential providers plus `llm-pi-ai`, so an SDK caller can select a provider route and exact model from the active dsh configuration while the child keeps ambient credential-shaped environment variables scrubbed. The SDK server forwards each structured question as a server-to-caller `interaction/request`; the TypeScript SDK's `onRequest` hook and the runner's `RunnerInteractionHandler` supply the answer in the same runtime session. The CLI adapter accepts an answer JSON line on stdin after the interaction progress record, so the caller can decide without exposing the question as a human-facing prompt.

The runner is repository tooling, not a Cordis plugin. It does not register services, tools, or providers and is not loaded by a Cordis configuration. The child process owns the plugin composition; the default JSON-RPC example uses the `dsh-subagent-spawn-in-process` provider, while the optional `dsh-subagent-dsh-sdk` package remains a Cordis provider for configurations that delegate to another DSH SDK runtime. The SDK client remains a pure library and owns JSON-RPC transport, while the runner owns caller-facing supervision and workspace evidence.

Child environment inheritance starts from `scrubbedParentEnv()`. Credential-shaped names and ambient `DSH_*` names are excluded unless the caller names them with `--forward-env`; the runner then explicitly sets `DSH_SESSION_ROOT` from `--session-root` or `$DSH_HOME/sessions`. A Web host using the same root lists the child session and observes appended events through a read-only persistence poller without resuming or marking the external session running.

## Alternatives considered

**Make the runner a Cordis plugin.** Rejected because a plugin is loaded inside the child composition and cannot own the process that loads it. Making supervision a plugin would couple process lifecycle to the very runtime it is meant to supervise.

**Call the SDK client directly from each caller.** Rejected because every caller would have to repeat timeout, teardown, error classification, workspace evidence, and shared-session-root rules. The SDK remains available for library consumers; the runner supplies one stable CLI policy for the common isolated-task workflow.

**Fork or wrap a third-party ACP server.** Rejected for the first implementation because the repository already owns a JSON-RPC runtime and a typed SDK client. ACP remains an automation protocol and can be added as a compatible runtime path later without making this runner responsible for ACP session semantics.

## Verification

The runner tests cover argument resolution, runtime configuration errors, Git path comparison, successful child completion, structured caller interaction, and bounded timeout reporting. The SDK client and server tests cover the bidirectional request path and wire answer validation. The external-session observer tests cover history baselining, contiguous append delivery, and stopping after local attachment; API proxy tests cover delivery through the Web mux and host streams without attaching the external session. The documented default path requires `pnpm run build` before execution because it consumes the built JSON-RPC runtime.

## Consequences

- Callers get one command and one machine-readable result for an isolated child task; completed and max-token-limited runs have exit code 0.
- The result is stable for automation, but the runner does not merge, stage, or revert child workspace changes; `changedPaths` and `diffCheck` are evidence for the caller.
- The default child remains the repository's example composition, so production deployments can supply another compatible command and runtime arguments.
- The runner's timeout, progress, and teardown policies are separate from the child's agent-loop policy; changing one does not silently change the other.
- The runner is suitable for an agent-side delegation wrapper. With the shared session root and Web host observer, its read-only conversation can appear in the DSH Web session list and receive appended events, but it is not a native Codex subagent task and is not resumed by the host.
