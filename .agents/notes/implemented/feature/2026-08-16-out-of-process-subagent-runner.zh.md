# Agent Note: 进程外 subagent runner 使用 SDK client

Status: implemented

[English](2026-08-16-out-of-process-subagent-runner.md) | 中文

## Problem

仓库已经有 JSON-RPC 运行时和 SDK client，但调用一个隔离的 child 任务仍需要调用者自行组合 child 命令、协议生命周期、超时、teardown 和工作区检查。这样一来，有用的 subagent 路径就依赖每个调用方自己的监督代码。

## Decision

仓库通过 `scripts/dsh-subagent-runner.ts` 提供 `pnpm dsh:subagent`。runner 使用 `examples/jsonrpc-agent/cordis.yml` 启动构建后的 `packages/examples/jsonrpc-demo/lib/bin.js`，通过 `@deepseek-ai/dsh-sdk-client` 发送一个任务，限制运行和 child teardown，并输出一个带版本的 JSON 结果。结果包含 child 响应、终止状态、请求路由、Git 状态快照、变更路径以及 `git diff --check`。

runner 会在 stderr 通过 JSON Lines 输出有界进度事件，覆盖启动、选定的 session/turn/tool 活动、空闲 heartbeat、调用方交互请求和最终状态。进度记录不包含任务文本、模型正文或工具参数；stdout 仍只保留最终结果 JSON，因此 agent 侧包装器可以观察运行中的 child，并独立解析完成结果。

默认 JSON-RPC 组合加载 `dsh-user-questions` 和 `dsh-tool-ask-user`，同时挂载文件型 settings、credentials provider 以及 `llm-pi-ai`，因此 SDK 调用方可以从当前 dsh 配置选择 provider 路由和精确 model；child 仍会清除环境中继承的凭据形式变量。SDK server 会将每个结构化问题作为服务端→调用方的 `interaction/request` 转发；TypeScript SDK 的 `onRequest` hook 和 runner 的 `RunnerInteractionHandler` 在同一个运行时 session 中提供答案。CLI 适配器会在交互进度事件之后从 stdin 接收一行 JSON 答案，因此调用方可以自行决定，而不会把问题暴露成面向人类的提示。

runner 是仓库工具，不是 Cordis 插件。它不会注册服务、工具或 provider，也不会由 Cordis 配置加载。child 进程拥有插件组合；默认 JSON-RPC 示例使用 `dsh-subagent-spawn-in-process` provider，可选的 `dsh-subagent-dsh-sdk` 包仍然是供委派到另一个 DSH SDK 运行时的配置使用的 Cordis provider。SDK client 仍是纯库并负责 JSON-RPC transport，runner 负责调用方可见的监督和工作区证据。

child 的环境继承从 `scrubbedParentEnv()` 开始。凭据形式的名称和环境中的 `DSH_*` 名称默认会被排除，只有调用者通过 `--forward-env` 指定时才会转发；runner 随后会把 `--session-root` 或 `$DSH_HOME/sessions` 明确设置为 `DSH_SESSION_ROOT`。使用相同根目录的 Web host 会列出 child session，并通过只读持久化轮询观察追加事件，但不会 resume 或把外部 session 标记为 running。

## Alternatives considered

**把 runner 做成 Cordis 插件。** 不采用，因为插件是在 child 组合内加载的，不能拥有加载它的进程。让监督逻辑成为插件会把进程生命周期绑定到它本来要监督的运行时。

**让每个调用方直接调用 SDK client。** 不采用，因为每个调用方都必须重复超时、teardown、错误分类、工作区证据和共享会话根目录规则。SDK 仍可供库消费者使用；runner 为常见的隔离任务工作流提供一套稳定的 CLI 策略。

**fork 或包装第三方 ACP server。** 首版不采用，因为仓库已经拥有 JSON-RPC 运行时和类型化 SDK client。ACP 仍是自动化协议，未来可以作为兼容运行时路径接入，而无需让 runner 负责 ACP 会话语义。

## Verification

runner 测试覆盖参数解析、运行时配置错误、Git 路径比较、child 成功完成、结构化调用方交互和有界超时报告。SDK client 与 server 测试覆盖双向请求路径和线上的答案校验。外部会话观察器测试覆盖历史基线、连续追加事件投递和本地挂接后的停止观察；API proxy 测试覆盖 Web mux 与 host 流的投递，并确认不会挂接外部会话。文档中的默认路径需要先运行 `pnpm run build`，因为它消费构建后的 JSON-RPC 运行时。

## Consequences

- 调用方可以用一条命令和一个机器可读结果运行隔离的 child 任务；完成或达到 max-token 上限的运行退出码为 0。
- 结果适合自动化，但 runner 不会合并、暂存或回滚 child 对工作区的修改；`changedPaths` 和 `diffCheck` 只是提供给调用方的证据。
- 默认 child 仍是仓库的示例组合，因此生产部署可以提供另一个兼容的 command 和 runtime arguments。
- runner 的超时、进度和 teardown 策略独立于 child 的 agent-loop 策略；改变其中一个不会静默改变另一个。
- runner 适合接入 agent 侧的委派包装。共享会话根目录和 Web host observer 让它的只读对话可以出现在 DSH Web 会话列表并接收追加事件，但它不是 Codex 原生 subagent 任务，host 也不会 resume 它。
