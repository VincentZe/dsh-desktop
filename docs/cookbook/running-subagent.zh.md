# 运行 dsh subagent

[English](running-subagent.md) | 中文

本实操手册介绍仓库级的 `pnpm dsh:subagent` 命令。该命令通过 dsh SDK JSON-RPC 客户端监督一个 child 任务，并将进度、最终结果和工作区证据放在不同的流中。

## 前置条件

请在仓库根目录运行命令，并准备 Node.js 22.19 或更高版本以及已安装的 workspace 依赖。

默认 JSON-RPC child 使用受沙盒保护的平台 shell：Windows 使用 `pwsh`，POSIX 使用 `bash`。所选 shell 与 filesystem 工具使用相同的权限和审批策略。

1. 使用 `pnpm install` 安装依赖。
2. 使用 `pnpm run build` 构建默认 child 运行时。
3. 在当前 dsh home 中配置 provider 路由和凭据。child 会直接读取受管的 settings 与 credentials 文档；runner 不会隐式继承看起来像凭据的环境变量。

默认 child 运行时是 [`examples/jsonrpc-agent/cordis.yml`](../../examples/jsonrpc-agent/cordis.yml)，由构建后的 [`@deepseek-ai/dsh-sdk-jsonrpc-demo`](../../packages/examples/jsonrpc-demo/README.md) 入口启动。

## 运行一个任务

传入一个位置参数作为任务，或使用 `--task`。provider 和 model 会一起传给 child 运行时，因此部署包含多个路由时应同时指定两者。

```sh
pnpm dsh:subagent -- "inspect the workspace and report actionable findings"
pnpm dsh:subagent --provider vocano --model deepseek-v4-flash-ga -- "review the changed files"
```

第二条命令要求当前配置中存在 `vocano` 路由，并且有一个 id 或唯一显示名称可解析为 `deepseek-v4-flash-ga` 的模型条目。请将 `vocano` 替换为目标模型所配置的 provider。

如果凭据只存在于父进程环境中，请显式转发该环境变量：

```sh
pnpm dsh:subagent --forward-env DEEPSEEK_API_KEY -- "run the requested check"
```

使用 `--cwd <path>` 选择 child 工作区，使用 `--session-root <path>` 选择 JSONL 持久化根目录，使用 `--max-tokens <n>` 限制模型输出，使用 `--timeout-ms <n>` 限制整个运行时间。`--cwd` 只解析一次，并同时用于 runtime 进程、session header、filesystem 与平台 shell provider，以及模型可见的任务前缀。child 还会收到 `DSH_CWD`；自定义 cordis 配置应使用这个变量配置工作区相关 provider。

## 使用后台 job 接口

需要同时监督多个 child 的代码可以使用 [`scripts/dsh-subagent-jobs.ts`](../../scripts/dsh-subagent-jobs.ts) 中的进程内 `RunnerJobManager`。`start()` 立即返回 `jobId`；`wait()` 按 cursor 长轮询进度；`respond()` 回答 pending 的结构化问题；`cancel()` 会等待 child 被回收。

```ts
declare const manager: {
  start(request: unknown): { jobId: string; cursor: number }
  wait(jobId: string, options: { afterCursor: number; timeoutMs: number }): Promise<{
    status: 'running' | 'waiting-input' | 'completed' | 'max-tokens' | 'aborted' | 'timed-out' | 'failed'
    nextCursor: number
    pendingInteraction?: unknown
  }>
  respond(jobId: string, answer: unknown): void
}
declare const request: unknown
declare function chooseAnswer(interaction: unknown): unknown

async function supervise(): Promise<void> {
  const started = manager.start(request)
  let cursor = started.cursor
  for (;;) {
    const snapshot = await manager.wait(started.jobId, { afterCursor: cursor, timeoutMs: 30_000 })
    cursor = snapshot.nextCursor
    if (snapshot.pendingInteraction !== undefined) {
      manager.respond(started.jobId, chooseAnswer(snapshot.pendingInteraction))
    }
    if (['completed', 'max-tokens', 'aborted', 'timed-out', 'failed'].includes(snapshot.status)) break
  }
}

void supervise()
```

`wait()` 会在有新事件、出现 interaction、job 结束或超时时返回。`nextCursor` 是当前最新 cursor，下一次传回它即可避免重复事件。job 和 terminal 结果只存在于当前进程，并在 manager 生命周期内保持可读。manager 本身不提供持久化；下面的 stdio adapter 提供进程间传输，但两层都不提供 adapter 退出后的持久化恢复。

对于 Codex 这类独立调用方，可以先启动一次 stdio adapter：

```powershell
pnpm --silent dsh:subagent-jobs
```

随后发送换行分隔的 JSON-RPC 请求。`job/start` 接受与 runner 相同的 `argv` 参数并立即返回；`job/wait` 返回 manager snapshot；`job/respond` 在 `answer` 字段中接收结构化回答；`job/cancel` 等待 child 收尾。调用方应以 `snapshot.status` 和 `nextCursor` 作为权威生命周期字段。

```json
{"jsonrpc":"2.0","id":1,"method":"job/start","params":{"argv":["--cwd","D:\\path\\to\\repo","--provider","vocano","--model","deepseek-v4-flash-ga","--permission","read-only","--task","Review the repository and report findings."]}}
```

## 设置 child 权限

默认 child 使用 `workspace-write` 和 `ask`：文件修改限制在 session workspace 与允许的临时目录内，模型请求扩大沙箱范围时按审批策略处理。权限由调用方在启动时决定，并作用于该 runner 创建的 child 会话：

```sh
pnpm dsh:subagent --permission read-only -- "inspect the repository without changing files"
pnpm dsh:subagent --permission workspace-write --approval ask -- "implement the requested fix"
pnpm dsh:subagent --permission danger-full-access --approval never -- "run the isolated migration"
```

`--permission` 可选 `read-only`、`workspace-write` 或 `danger-full-access`；`--approval` 可选 `ask` 或 `never`。未显式传入 `--approval` 时，前两种权限使用 `ask`，`danger-full-access` 使用 `never`。默认 JSON-RPC 配置通过 `DSH_PERMISSION_MODE`、`DSH_APPROVAL_POLICY` 接入共享沙箱和审批插件；JSON-RPC 运行时没有人机审批界面，未配置审批应答者的升级请求会按拒绝处理。使用 `--config` 时，自定义配置必须自行消费这两个环境变量并挂载对应的 sandbox/approval provider，runner 不会替它改写插件组合。

## 在 Web 界面中归组 child

使用 `--workspace-path <path>` 可以按路径幂等查找或创建 Web workspace，并在 child session 结束后把它挂入该 workspace：

```sh
pnpm dsh:subagent --cwd D:\path\to\repo --workspace-path D:\path\to\repo --web-url http://127.0.0.1:3080 -- "review the repository"
```

如果 Web workspace 已有稳定 id，可以使用 `--workspace-id <id>`。`--no-workspace` 会显式关闭上述绑定选项。runner 只在 child 结束后调用 Web host，因此不会在 child 写日志期间 resume 或 attach 活跃 session。Web URL 默认是 `http://127.0.0.1:3080`；设置 `DSH_WEB_URL` 后使用该值。

使用默认 URL 且 Web host 不可达时，路径绑定按尽力策略处理：stdout 会报告 `workspace.status: "skipped"`，child 结果仍可正常使用。显式传入 Web URL 或 Web API 返回业务错误时，`workspace.status` 会是 `"failed"`。Web host 必须使用与 runner 相同的 `--session-root`，才能看到 child session。

## 读取两个流

runner 会向 stdout 写入且只写入一个最终 JSON 对象。它包含 `status`、最终 `output`、解析后的 `request`，以及包含 Git 前后状态、变更路径和 `git diff --check` 结果的 `evidence`；失败时还会包含 `error` 对象。

进度以换行分隔的 JSON 写入 stderr。阶段包括 `started`、`activity`、`heartbeat`、`interaction` 和 `finished`。进度携带 provider、model、session 活动、工具名称和停止状态等生命周期事实，但不携带任务文本、模型正文或工具参数。失败的 `tool/result` 会额外携带 `toolName` 和有界的 `toolError` 摘要，其中包含可用的错误名称、代码和规范化消息；不会包含 call id 或完整工具结果。使用 `--quiet` 关闭进度，或使用 `--progress-ms <n>` 调整空闲 heartbeat 间隔。

进程在 `completed` 和 `max-tokens` 且 workspace 绑定没有失败时返回退出码 `0`，child 失败、超时、中止或显式 workspace 绑定失败时返回退出码 `1`，runner 参数无效时返回退出码 `2`。非零退出码不代表 stdout 不可用：已接受的 child 失败或超时仍会输出结构化结果 JSON。

## 回答问题

child 可以通过 `ask_user_question` 请求结构化回答。runner 会在 stderr 发出 `phase: "interaction"` 的进度记录，并在其中携带完整的 `interaction` 请求。调用方决定策略，并向 runner 的 stdin 写入一行 JSON 答案，同时回显请求 id：

```json
{"requestId":"...","answers":[{"id":"mode","selected":["fast"]}]}
```

请使用请求中的问题 id 和选项标签。协议会拒绝未知问题 id、未提供的选项、重复回答，以及单选问题中的多项选择。将问题从 `answers` 中省略即可跳过该问题。这条路径由调用方控制，不会自动打开面向人的提问窗口。

## 共享会话

runner 默认把 child 的 `DSH_SESSION_ROOT` 设置为 `$DSH_HOME/sessions`。使用相同持久化根目录的 Web host 可以以只读历史的形式列出并观察 child session；它不会 attach、resume child，也不会把 child 标记为 running。host 使用其他根目录时，请用 `--session-root` 传入相同的显式路径。workspace 绑定会在任务结束后增加 Web 分组记录，不会改变 child session 日志。

runner 是仓库脚本，不是 Cordis 插件。使用 `--config` 替换默认 child 组合。使用可重复的 `--runtime-arg` 参数启动其他兼容 JSON-RPC 运行时；传入 `--runtime-arg` 后不能再与 `--config` 组合。完整选项解析器维护在 [`scripts/dsh-subagent-runner.ts`](../../scripts/dsh-subagent-runner.ts) 中。
