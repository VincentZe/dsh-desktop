# Agent Note: Runner child session 的 Web workspace 绑定

Status: implemented

[English](2026-08-17-runner-web-workspace-binding.md) | 中文

## 问题

runner 虽然与 Web host 共享 child session 日志，但新建 child session 没有记入 Web workspace，因此会显示在 `Ungrouped` 中。

## 决策

runner 接受已有的 `--workspace-id` 或目录形式的 `--workspace-path`，并支持可选的 `--web-url`。child 结束且 runtime 关闭后，路径模式调用 `workspace.create`，两种模式都使用结束后的 child session id 和 workspace id 调用 `session.create`。路径创建是幂等的。路径模式使用默认本地 URL 且 Web host 不可达时，绑定报告为 `skipped`；显式 URL 或 Web API 业务错误报告为 `failed`。`--no-workspace` 优先于其他 workspace 选项。

## 考虑过的替代方案

**对每个 child 调用 `workspace.insertSessionBefore`。** 冷 session 尚未记账，该操作会被 Web host 拒绝。`session.create` 才是将 session 发布到 workspace 账户中的 API。

**child 运行期间绑定。** child runtime 同时写入 session 日志，Web host 可能看到不完整 session。结束后绑定可以避免 resume 或 live ownership 竞争。

**让所有 runner 调用都强制依赖 Web 分组。** runner 也会在没有 Web host 时使用。可选的路径绑定保留 CLI 用法，同时让调用方能读取结构化状态。

## 后果

Web UI 可以把已完成的 child session 显示在指定目录 workspace 下，同时不改变 child 日志格式或 runtime 协议。host 和 child 必须使用相同的 session root。绑定被跳过表示 child 已运行但仍未归组；绑定失败会与 child 运行状态分开报告。
