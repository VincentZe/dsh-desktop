# Agent Note: JSON-RPC Windows shell 选择

状态：已实现

[English](2026-08-18-jsonrpc-windows-shell-selection.md) | 中文

## 问题

JSON-RPC 示例在所有平台都挂载受沙盒保护的 Bash executor 和 Bash tool。Windows 上，MSYS2 runtime 会使用交互用户 SID 创建 signal pipe。workspace-write restricted token 有意不包含该 SID，因此 child 在命令执行前就以 `couldn't create signal pipe, Win32 error 5` 失败。

## 决策

按平台门控 JSON-RPC shell 组合：POSIX 加载 `dsh-bash-sandbox` 和 `dsh-tool-bash`；Windows 加载 `dsh-pwsh-sandbox` 和 `dsh-tool-pwsh`。由于平台专用 tool row 不再通过 agent-spine 的 Bash consumer 间接提供，配置显式挂载 shell environment provider。示例 package 同时声明 PowerShell sandbox 依赖，保证干净部署可以解析该 row。

## 已考虑的替代方案

**将用户 SID 加入 restricted token。** 这会让 workspace 外部的用户 DACL 授权重新可用，削弱 `workspace-write`。

**不经过 ACL runner 运行 Git Bash。** 这能绕过 signal-pipe 错误，但会静默移除 JSON-RPC child 的文件策略。

**保留 Bash tool 名称但实际运行 PowerShell。** Bash 与 PowerShell 的引号、变量、路径和进程语义不同；展示一种方言却执行另一种方言会导致模型可见的命令失败。

## 结果

JSON-RPC runtime 在 POSIX 广告 `bash`，在 Windows 广告 `pwsh`。tool 仍只允许前台执行，并使用同一套权限与审批环境。极简 JSON-RPC 变体仍仅支持 POSIX，因为它有意使用持久 Bash PTY。
