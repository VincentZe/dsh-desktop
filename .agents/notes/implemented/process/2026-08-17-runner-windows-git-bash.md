# Agent Note: Runner Windows Git Bash discovery

Status: implemented

English | [中文](2026-08-17-runner-windows-git-bash.zh.md)

## Problem

The runner accepts custom JSON-RPC runtime arguments and configurations that may expose a Bash capability on Windows. Git for Windows commonly exposes `git.exe` through its `cmd` directory while keeping `bash.exe` in the sibling `bin` directory. A scrubbed child environment can therefore run Git while a custom Bash tool fails with `spawn bash ENOENT`.

## Decision

On Windows, the runner checks whether `bash` is already discoverable. If it is missing, it inspects the PATH-resolved `git.exe` entries and prepends a sibling `bin` directory containing `bash.exe` to the child PATH. The adjustment is process-local; it does not install software or modify the user's global environment. Other platforms and environments with an existing `bash` resolution are unchanged. The default JSON-RPC composition uses sandboxed `pwsh` on Windows; Git Bash discovery remains available only to compatible custom child compositions.

## Alternatives considered

**Install or modify the user's global Git Bash setup.** Git Bash was already present on the target machine, and global environment changes would affect unrelated applications and require process restarts.

**Hardcode `D:\\Mini\\Git\\bin`.** This fixes one machine but breaks portable Git installations at other paths. Deriving the directory from `git.exe` preserves the Windows installation convention without a machine-specific path.

**Remove Git Bash discovery because the default Windows composition uses PowerShell.** The runner also accepts custom runtime arguments and configurations. A custom composition that explicitly advertises Bash still requires Bash quoting and process semantics; silently substituting PowerShell would make its model-visible tool inaccurate.

## Consequences

Custom Windows child compositions can use an available Git for Windows installation without additional setup when `git.exe` is discoverable. The default composition does not depend on Git Bash. A custom Bash composition on a machine with neither `bash` nor a PATH-resolved Git installation still reports the original missing-executable failure and must provide a compatible Bash installation or runtime environment.
