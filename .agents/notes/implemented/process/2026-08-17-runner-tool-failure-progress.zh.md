# Agent Note: Runner 工具失败进度摘要

Status: implemented

[English](2026-08-17-runner-tool-failure-progress.md) | 中文

## 问题

runner 只报告工具已经启动并结束，没有说明 `tool/result` 是否失败，也没有在 stderr 进度流中给出简短失败原因。因此，监督长任务的调用方必须等到 child 返回最终响应，才能知道它是在恢复还是在重复失败。当最终 `turn/end` 携带 `reason.kind: "error"` 时，runner 虽然返回失败状态和停止原因，但没有把 provider 错误详情写入 `RunnerResult.error`。

## 决策

runner 将失败的 `tool/result` 会话事件映射为 `activity` 进度记录，携带 `message: "<tool> failed"`、`toolName` 和有界的 `toolError` 摘要。摘要保留事件中可用的错误名称和代码，只提取第一段文本错误内容，规范化控制空白字符，遮蔽 account、user、tenant 和 request 标识，并将结果限制为 240 个字符。工具调用关联按 session id 和 call id 作用域保存，但不会向外发送 call id。

成功的工具结果继续使用原有的 `"<tool> finished"` 进度消息。任务文本、工具参数、完整工具结果和模型消息仍不进入进度流。

当 child 最终的 `turn/end` 携带 `reason.kind: "error"` 时，runner 将其错误映射到 `RunnerResult.error`，其中包含 `name: "ChildTurnError"`、经过限制和脱敏的消息以及可用的 provider 错误代码。传输、超时、取消和清理失败继续使用各自已有的 runner 错误名称。

## 考虑过的替代方案

**透传完整的 `tool/result` 事件。** 这会暴露调用方监督任务不需要的工具输出和调用元数据，并可能泄露文件内容或凭据。有界摘要可以保留恢复信号，而不会把进度流变成对话记录。

**等待最终 assistant 响应。** 这会让长任务的调用方在 child 重试或切换工具期间失去状态，这正是本记录要解决的问题。

**只暴露最终停止原因。** `"error"` 可以说明任务失败结束，却无法区分 provider 订阅失败和其他模型请求失败。保留有界的 provider 消息和代码后，调用方无需读取私有 session 存储即可分类结果。

**把失败加入 SDK wire protocol。** 现有会话事件已经携带失败信息，缺少的是 runner 的展示行为；修改共享协议会扩大影响面，却不能帮助 runner 之外的消费者。

## 后果

调用方可以在 child 仍运行时基于结构化工具失败显示状态或执行自动处理，也可以从最终 JSON 结果中分类已经结束的模型失败。这些摘要是诊断信息而不是完整错误记录；需要完整回放的调用方仍应读取持久化 session，后续新增的错误内容也继续受固定长度限制。
