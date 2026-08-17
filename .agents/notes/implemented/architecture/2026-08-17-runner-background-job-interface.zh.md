# Agent Note: Runner 后台 job 接口

Status: implemented

[English](2026-08-17-runner-background-job-interface.md) | 中文

## 问题

一次性 runner 要求调用方一直等待 child 进程，并且只通过 stderr 暴露进度。因此，host adapter 无法同时启动多个 child、稍后继续轮询、独立回答 interaction，或通过稳定 id 取消某个任务。

## 决策

`RunnerJobManager` 管理进程内 child job，提供四个操作：`start()` 立即返回 job id 和 cursor；`wait()` 按 cursor 长轮询进度；`respond()` 校验并释放当前 interaction 请求；`cancel()` 中止 runner 并等待 child 收尾。每个进度事件获得单调递增的 job 内 cursor。Terminal job 会在 manager 生命周期内保留结果。

`executeRunnerRequest()` 接受可选的 `AbortSignal`。取消通过现有的 SDK 进程释放梯子关闭 harness，并报告 `aborted`；不会增加 wire-level cancel 方法。manager 只提供进程内接口。`scripts/dsh-subagent-jobs-server.ts` 通过长驻的换行分隔 JSON-RPC stdio adapter 暴露相同生命周期，支持 `job/start`、`job/wait`、`job/respond`、`job/cancel` 和 `job/shutdown`；它复用 runner 的 argv 解析器，使 model、workspace、permission 和 approval 的选择与一次性 CLI 保持一致。

## 考虑过的替代方案

**先把 CLI 改成 daemon。** 这会在生命周期语义稳定之前引入进程所有权和重启协议，也会破坏现有的一次性命令边界。

**复用已有的 `packages/jobs` service。** 该 service 受 Cordis runtime 内的 dsh agent 所有权和 session fence 约束，并不负责外部 SDK child 进程。

**把取消加入 SDK wire protocol。** 当前 client 已经通过 `close()` 提供有界 child 收尾；wire cancel 请求还需要 runtime 侧状态和持久化规则。runner 可以先提供有用的取消能力，不扩大共享协议。

## 后果

调用方可以通过有界长轮询监督多个任务，也可以在不阻塞前台 CLI 的情况下处理结构化问题。父进程可以保持一个 stdio adapter 长驻，并保存每个 `jobId` 及最新 cursor。adapter 退出后 job id 和事件历史仍会消失，当前没有保留上限或跨进程恢复；持久化 adapter 在把 id 暴露到 adapter 生命周期之外前必须先定义这些规则。
