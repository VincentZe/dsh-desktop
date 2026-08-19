# Agent Note: Fixed Web SEA dispatches the Windows ACL runner

Status: implemented

English | [中文](2026-08-18-fixed-web-sea-acl-runner-dispatch.zh.md)

## Problem

The Windows ACL runner was launched as `[process.execPath, runner.js, ...]` in the fixed Web portable runtime. The runtime is a Node SEA executable, so it does not execute a JavaScript file supplied after its executable path. Runner flags such as `--workspace` therefore reached the confined command and could be interpreted by Git or another tool.

## Decision

The fixed Web entry recognizes the reserved `--dsh-windows-acl-runner` marker and calls `runWindowsAclRunner()` in-process with the remaining runner argv. `dsh-sandbox-local` uses `[process.execPath, --dsh-windows-acl-runner]` for a SEA process and keeps the source and built JavaScript runner entry for ordinary Node launches. The runner module is import-safe and only starts from its direct script entry.

The marker is consumed before Web startup arguments are parsed. The runner still receives `--workspace`, `--temp`, `--mode`, optional capability SIDs, `--`, and the caller command in the existing order; no runner flag is appended to the caller command.

## Alternatives considered

**Ship a second runner executable.** Rejected because the fixed Web SEA already contains the runner implementation and a second executable would add packaging, version, and deployment drift.

**Strip `--workspace` from the caller command.** Rejected because it hides the argv ownership error and would corrupt a legitimate caller argument with the same spelling.

**Keep passing `runner.js` to the SEA executable.** Rejected because Node SEA treats the path as an ordinary argument and cannot use it as a script entry.

## Verification

The dispatch tests cover SEA and source argv layouts. The local sandbox test covers the fixed-runtime runner prefix and verifies that the runner marker precedes `--workspace`. TypeScript build and the Windows ACL runner suite cover the import-safe runner path and existing ACL behavior. The portable build must be smoke-tested by running a Git command through the fixed executable and confirming Git does not receive `--workspace`.

## Consequences

- The portable fixed Web runtime has one executable for Web startup and Windows ACL runner dispatch.
- The marker is a reserved process argument and must not be forwarded to Web startup or the confined command.
- Source development retains the direct `runner.js` path, so local tests and non-SEA deployments do not depend on the fixed Web entry.
- The portable artifact must be regenerated whenever this dispatch code changes.
