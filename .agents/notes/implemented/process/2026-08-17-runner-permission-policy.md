# Agent Note: Runner child permission policy

Status: implemented

English | [中文](2026-08-17-runner-permission-policy.zh.md)

## Problem

The runner had no caller-controlled permission input, and its default JSON-RPC composition used unconfined local bash and filesystem providers. A caller therefore could not select a child file policy, and a reported workspace could be mistaken for an execution restriction.

## Decision

The runner accepts `--permission read-only|workspace-write|danger-full-access` and `--approval ask|never`. It resolves `workspace-write + ask` by default, changes approval to `never` when full access is explicitly selected without an override, and passes the resolved values as `DSH_PERMISSION_MODE` and `DSH_APPROVAL_POLICY`. The bundled JSON-RPC composition consumes those values through the shared sandbox policy, sandboxed bash, sandboxed filesystem, and approval plugins. Custom compositions receive the same variables but remain responsible for mounting and consuming the matching capabilities.

## Alternatives considered

**Only add CLI metadata.** This would let callers declare a policy without changing execution, which is unsafe because the previous local providers were not confined.

**Expose only a permission preset.** The runner also needs an independent approval override for unattended callers, so the two mechanism-level values remain explicit at this process boundary.

**Use a human approval UI in the JSON-RPC child.** The child is an automation runtime with protocol-owned stdout; without a configured machine answerer, approval requests fail closed instead of opening an implicit prompt.

## Consequences

The default runner child is workspace-confined and caller-selectable. The policy is fixed when the runner launches its child process; changing it during a live run requires a runtime that exposes a session permission command or a new child session. A custom `--config` can still ignore these deployment variables, so its composition must be reviewed when stronger enforcement is required.
