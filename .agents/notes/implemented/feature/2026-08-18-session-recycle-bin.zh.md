# Agent Note: 通过持久化七天回收站处理会话删除

Status: implemented

[English](2026-08-18-session-recycle-bin.md) | 中文

## Problem

Workspace 浏览器此前可以通过归档隐藏会话，但没有支持恢复的用户删除流程，也没有协调持久化会话日志删除的机制。只在 UI 中记录删除标记会导致多个标签页状态分叉，并且自动清理后仍可能留下过期的冷会话摘要。

## Decision

Workspace 注册表持久化有序的 `trashedSessions` 记录，每条记录包含 `sessionId` 和 `deletedAt` 时间戳。移入回收站、恢复和永久删除通过 workspace RPC 命名空间提供，并通过完整快照 Host frame 镜像。

客户端根据注册表快照派生固定的回收站分组。普通分组、单列表模式、搜索、拖拽操作和多选都会排除回收站会话。浏览器提供顶部选择模式、原生复选框、会话右键菜单、恢复和永久删除操作。

持久化层提供仅针对冷会话的 `remove()` 操作，JSONL 后端删除会话目录，SQLite 后端删除会话行。注册表在启动时及每小时执行清理；超过七天的记录在对应 Session 不处于实时状态时删除。物理删除会发出 `workspace/session-deleted`，Host 将该事件转换为 `host/session-removed`，因此手动删除和自动清理都会让已连接客户端移除会话摘要。

空白占位会话和 subagent 会话不会出现在 Workspace 浏览器的可选或可删除列表中。会话进入回收站时不改变 Workspace 记账，因此恢复后会回到原来的分组和位置。

## Alternatives considered

**立即删除会话日志。** 这会让右键菜单误操作不可恢复，也无法提供所需的回收站分组；持久化标记将用户删除与物理删除分开。

**只在浏览器本地保存删除状态。** 本地标记无法在多个标签页之间收敛，也无法在刷新后保留；workspace 领域已经负责持久化分组状态和完整快照 frame。

**由 workspace 注册表释放实时 Agent。** Agent 释放是由持有生命周期 handle 的所有者提供的能力，而注册表只有会话 id；因此注册表只删除冷日志，实时记录等待其生命周期结束。

## Verification

针对 UI、Host workspace API、客户端 runtime、workspace 注册表以及 JSONL/SQLite 持久化的聚焦测试覆盖选择、右键菜单操作、恢复、永久删除、清理记录和删除 frame。`pnpm run typecheck` 已通过。Workspace 与 SQLite 测试套件仍包含 Windows 符号链接测试；当前账户无法创建目录符号链接时会因 `EPERM` 失败。

## Consequences

删除的冷会话在七天内可恢复。实时会话可能在超过七天后仍留在回收站，直到其 Agent 生命周期结束并执行下一次清理；这保持了现有 Agent 所有权约定，但意味着对实时会话而言七天是最短保留期而不是严格上限。
