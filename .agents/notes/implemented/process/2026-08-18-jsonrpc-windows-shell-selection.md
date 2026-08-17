# Agent Note: JSON-RPC Windows shell selection

Status: implemented

English | [中文](2026-08-18-jsonrpc-windows-shell-selection.zh.md)

## Problem

The JSON-RPC example mounted the sandboxed Bash executor and Bash tool on every platform. On Windows, Git Bash's MSYS2 runtime creates its signal pipe with the interactive user's SID. The workspace-write restricted token intentionally omits that SID, so the child failed before the command ran with `couldn't create signal pipe, Win32 error 5`.

## Decision

Gate the JSON-RPC shell pair by platform: POSIX loads `dsh-bash-sandbox` and `dsh-tool-bash`; Windows loads `dsh-pwsh-sandbox` and `dsh-tool-pwsh`. The shell environment provider is mounted explicitly because the platform-specific tool rows no longer arrive through the agent-spine Bash consumer. The example package declares the PowerShell sandbox dependency so clean deployments resolve the row.

## Alternatives considered

**Add the user SID to the restricted token.** This would make user-owned DACL grants available outside the selected workspace and weaken `workspace-write`.

**Run Git Bash without the ACL runner.** This avoids the signal-pipe error but silently removes the file policy from the JSON-RPC child.

**Keep the Bash tool name while running PowerShell.** Bash and PowerShell have different quoting, variables, paths, and process semantics; presenting one dialect while executing the other causes model-visible command failures.

## Consequences

The JSON-RPC runtime advertises `bash` on POSIX and `pwsh` on Windows. The tool remains foreground-only and uses the same permission and approval environment. The minimal JSON-RPC variant remains POSIX-only because it intentionally uses a persistent Bash PTY.
