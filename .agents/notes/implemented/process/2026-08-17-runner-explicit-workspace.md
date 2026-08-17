# Agent Note: Explicit workspace for runner child tasks

Status: implemented

English | [中文](2026-08-17-runner-explicit-workspace.zh.md)

## Problem

The runner already passed `--cwd` to the child process and SDK session, but the default child persona did not expose that value to the model. A child using a custom persona could also receive a correct tool directory while inventing a different workspace in its task reasoning.

## Decision

The runner resolves `--cwd` once and sets `DSH_CWD` after the scrubbed environment is created, so child cordis configurations can use the same path for workspace-scoped providers. Each model task receives a short workspace prefix containing the resolved absolute path and an explicit instruction to use it unless the task names another path. The bundled JSON-RPC persona also renders dsh's native `{{cwd}}` variable in its system prompt.

## Alternatives considered

**Rely only on the process and session cwd.** Tools and session metadata would be correct, but the model would still have no guaranteed model-visible path when a persona omits `{{cwd}}`.

**Enable workspace instruction loading as the workspace signal.** `workspaceContext` loads instruction files such as `AGENTS.md`; it does not itself guarantee that the absolute workspace path appears in the prompt, and enabling it changes prompt composition beyond this runner concern.

**Let each custom cordis config choose an environment variable.** This preserves local flexibility but allows the runtime, tools, and model to drift apart. `DSH_CWD` is now the runner-owned input while custom configs retain control over how they consume it.

## Consequences

The runner's process, session, providers, and task prompt share one resolved workspace. A task that explicitly names another path can still request work outside the default workspace. Custom personas should retain `{{cwd}}` when they want the native system-prompt form; the runner task prefix remains the fallback for custom runtimes.
