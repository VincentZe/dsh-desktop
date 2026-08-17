# Agent Note: Web workspace binding for runner child sessions

Status: implemented

English | [中文](2026-08-17-runner-web-workspace-binding.zh.md)

## Problem

The runner shared child session logs with the Web host, but a newly created child session was not accounted under a Web workspace and therefore appeared in `Ungrouped`.

## Decision

The runner accepts an existing `--workspace-id` or a directory `--workspace-path`, plus an optional `--web-url`. After the child settles and its runtime is closed, path mode calls `workspace.create` and both modes call `session.create` with the settled child session id and workspace id. Path creation is idempotent. When path mode uses the default local URL and the Web host is unavailable, the binding is reported as `skipped`; explicit URLs and Web API business errors are reported as `failed`. `--no-workspace` takes precedence over all workspace options.

## Alternatives considered

**Call `workspace.insertSessionBefore` for every child.** A cold session is not yet accounted by that operation, so the Web host rejects the move. `session.create` is the API that publishes the session into a workspace account.

**Attach while the child is running.** The child runtime is concurrently appending its session log and the Web host may observe an incomplete session. Binding after settlement avoids resume or live ownership races.

**Make Web grouping mandatory for every runner invocation.** The runner is also used without a Web host. Optional path binding preserves CLI use while returning a structured status that callers can inspect.

## Consequences

The Web UI can show completed child sessions under the requested directory workspace without changing the child log format or runtime protocol. The host and child must use the same session root. A skipped binding means the child still ran but remains ungrouped; a failed binding is visible separately from the child run status.
