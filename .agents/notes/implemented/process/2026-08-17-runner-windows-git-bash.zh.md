# Agent Note: Runner 的 Windows Git Bash 发现

Status: implemented

[English](2026-08-17-runner-windows-git-bash.md) | 中文

## Problem

runner 接受自定义 JSON-RPC runtime 参数和配置，这些 child 在 Windows 上仍可能暴露 Bash capability。Git for Windows 通常只通过 `cmd` 目录暴露 `git.exe`，而 `bash.exe` 位于同级的 `bin` 目录。清理后的 child 环境因此可能可以运行 Git，却让自定义 Bash 工具以 `spawn bash ENOENT` 失败。

## Decision

在 Windows 上，runner 会先检查 `bash` 是否已经可发现。如果缺失，就检查 PATH 中可解析到的 `git.exe`，并将其中包含 `bash.exe` 的同级 `bin` 目录加入 child PATH 的首位。这个调整只作用于当前进程，不会安装软件或修改用户全局环境。其他平台以及已经能解析 `bash` 的环境保持不变。默认 JSON-RPC 组合在 Windows 上使用受沙盒保护的 `pwsh`；Git Bash 发现只供兼容的自定义 child 组合使用。

## Alternatives considered

**安装或修改用户的全局 Git Bash 配置。** 目标机器已经存在 Git Bash，全局环境变更会影响无关应用，还需要重启已有进程。

**硬编码 `D:\\Mini\\Git\\bin`。** 这能修复一台机器，却会在其他路径的便携 Git 安装上失效。从 `git.exe` 推导目录可以遵循 Windows 安装约定，而不绑定机器路径。

**因为默认 Windows 组合使用 PowerShell 而删除 Git Bash 发现。** runner 还接受自定义 runtime 参数和配置。显式暴露 Bash 的自定义组合仍要求 Bash 的引号和进程语义；静默替换为 PowerShell 会让其模型可见工具与实际行为不符。

## Consequences

当 PATH 可以找到 Git for Windows 时，自定义 Windows child 组合可以直接使用其中的 Bash，不需要额外安装。默认组合不依赖 Git Bash。对于自定义 Bash 组合，既找不到 `bash` 又找不到 PATH 中 Git 安装的机器仍会报告原有的 executable 缺失错误，需要提供兼容的 Bash 安装或 runtime 环境。
