# Agent Note: Isolate desktop package deployment from the workspace

Status: implemented

English | [中文](2026-08-17-desktop-pkg-outside-workspace.zh.md)

## Problem

The fixed Web packaging command runs a production `pnpm deploy` for the monorepo's CLI package. The legacy deploy implementation can run a production dependency-status repair against the source workspace. In a non-interactive packaging process this may abort while removing `node_modules`, leaving the source runner unable to start before it reaches the Web host.

## Decision

The build copies source inputs, excluding generated desktop output, `.git`, and every `node_modules` directory, into a temporary workspace. `pnpm deploy` runs from that copy and writes the real staging directory through an absolute path. The copied workspace is removed before `pkg` runs; `pnpm dlx pkg` also runs from the repository's parent directory. The source workspace never becomes the install target, while the deployed package still uses the same manifests, lockfile, built JavaScript, and package assets.

## Alternatives considered

**Set `confirmModulesPurge=false` and keep running from the repository root.** This avoids the non-interactive prompt but permits the packaging command to mutate the source workspace's dependency tree, so it hides rather than removes the coupling.

**Use `npx` for pkg.** A second package-manager path would have a separate cache and configuration surface. The existing pnpm cache remains sufficient when the command runs outside the workspace.

**Add the supervisor runner to the portable executable in this change.** The runner and the fixed Web host have separate lifecycle and dependency contracts. Packaging isolation fixes the observed source-runner failure; a standalone runner distribution remains a separate product decision.

## Consequences

The desktop package can be regenerated without triggering a workspace production install from either the deploy or pkg step. The portable package still contains only the fixed Web host and native shell; source-based `dsh-subagent` invocation remains owned by the repository runner and requires the repository dependencies.

## Testing

The deployment copy is checked by rebuilding the runtime and then running the runner from the source workspace without a dependency repair. The pkg command still runs from the repository parent directory. The portable package contents remain the fixed Web host and native shell; the standalone runner remains a separate product decision.
