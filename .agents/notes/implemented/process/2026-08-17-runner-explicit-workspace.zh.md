# Agent Note: Runner child 任务的显式工作区

Status: implemented

[English](2026-08-17-runner-explicit-workspace.md) | 中文

## Problem

runner 已经把 `--cwd` 传给 child 进程和 SDK session，但默认 child persona 没有把这个值暴露给模型。使用自定义 persona 时，也可能出现工具目录正确、模型却在任务推理中编造另一个 workspace 的情况。

## Decision

runner 只解析一次 `--cwd`，并在创建清理后的环境后设置 `DSH_CWD`，这样 child 的 cordis 配置可以使用同一个路径配置工作区相关 provider。每个模型任务都会收到一段简短的 workspace 前缀，其中包含解析后的绝对路径，并明确要求除非任务指定其他路径，否则使用该路径。内置 JSON-RPC persona 也会在系统提示词中渲染 dsh 原生的 `{{cwd}}` 变量。

## Alternatives considered

**只依赖进程和 session 的 cwd。** 工具和 session 元数据会正确，但如果 persona 没有使用 `{{cwd}}`，模型仍然没有保证可见的路径。

**把 workspace instruction 加载作为 workspace 信号。** `workspaceContext` 会加载 `AGENTS.md` 等指令文件，但不会保证绝对 workspace 路径出现在提示词中；启用它还会超出本 runner 问题的范围改变提示词组成。

**让每个自定义 cordis 配置自行选择环境变量。** 这保留了局部灵活性，却允许 runtime、工具和模型之间再次出现偏差。现在由 runner 持有 `DSH_CWD` 输入，同时自定义配置仍可决定如何消费它。

## Consequences

runner 的进程、session、provider 和任务提示词共享同一个已解析 workspace。任务仍可明确指定其他路径来请求工作。自定义 persona 如果需要原生系统提示词形式，应保留 `{{cwd}}`；对于自定义 runtime，runner 注入的任务前缀仍会提供兜底。
