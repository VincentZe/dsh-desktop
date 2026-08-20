# Issue 0001：子进程树无法终止时，工具调用会无限挂起

[English](0001-tool-execution-hang-no-hard-timeout.md) | 中文

状态：部分修复——硬兜底已于 2026-08-20 落地（	imeout-policy）；进程树终止加固仍待处理

## 摘要

`tool-bash` / `tool-pwsh` 等 shell 工具的超时是**协作式**的：timeout-policy 只中止执行信号，从不遗弃工具的 promise。如果子进程树无法被终止（Windows 上 `taskkill /T /F` 可能失败或漏掉逃逸的后代进程），`handle.done` 永不 settle，工具调用永远不完成：`tool/result` 不落盘、模型收不到超时信息、agent 永远卡在这一个 step 上。若在卡死期间关闭会话，崩溃恢复会在下次加载时补写一条 `TOOL_OUTCOME_UNKNOWN`（"no result was durably recorded"）结果。

## 影响

- 一条长时间命令（例如全盘递归搜索）就能让 agent 永久卡死在单个工具步骤上。
- 超时结果既不落盘也不送达模型，模型无法自行决定重试或放弃。
- 会话中断恢复后 agent 不会自动继续，需要用户再发消息驱动。

## 复现路径

1. 运行一条足够久、且进程树难以被杀掉的命令（全盘递归、spawn 了脱离的后代进程、或忽略终止信号的进程）。
2. 工具调用永不返回，turn 一直保持打开。
3. 关闭应用；下次加载会话时，repair 层注入 `TOOL_OUTCOME_UNKNOWN` 结果。

## 根因

- `timeout-policy`（`packages/guard/timeout-policy/src/index.ts`）按设计是协作式的——注释原文 *"without racing or abandoning the tool promise"*。超时只 abort 信号，wrapper 仍停留在 `await next()`。
- `pwsh-local` 无条件等待子进程（`packages/shell/pwsh-local/src/index.ts` 的 `runArgv`：`const outcome = await handle.done`），该等待没有独立的硬性 deadline。
- `spawn.ts`（`packages/subprocess/subprocess-local/src/spawn.ts`）在 Windows 上没有进程树存活探测：*"Windows has no group-liveness probe; the direct child's exit is the observable boundary"*；`taskkill` 的结果有意不检查，逃逸的后代会让"树仍然活着"且无法确认静默。
- 工具调用调度器（`packages/core/agent-loop/src/tool-calls.ts`）只 race 已启动的 dispatch，没有整体执行预算能在工具永不 settle 时强制产出结果。
- 连锁结果：`taskkill` 没杀干净 → `handle.done` → `next()` → `tool/result` 全部挂起，超时信息永远到不了模型。

## 上游状态（2026-08-20 检查，deepseek-ai/deepseek-harness master，rc.8）

- 没有针对本问题的直接修复。
- 上游新增了 `windows-inspector.ts` 与 `terminal.ts`（persistent-pty 特性分支，node-pty 1.2 beta），但只服务于 persistent terminal 路径；普通 `spawn` 在 Windows 上的 `treeAlive()` 逻辑未变。
- `timeout-policy` / `pwsh-local` / `spawn.ts` 的协作式超时结构与本地一致。
- 决策：先合并上游（计划中，rc.5 → rc.8），再在本地处理本问题。

## 建议修复方向

1. 在工具执行层加硬兜底：用 `Promise.race` 把工具结算与强制 deadline（`timeoutMs` + grace）赛跑，即使子进程仍在运行也落盘一条 `TOOL_TIMEOUT` 结果。
2. 落盘后继续终止后台进程树（detached），避免资源被无限占用。
3. 让 Windows 的进程树终止更可靠（Job Object，或参照上游 `windows-inspector.ts` 做进程树枚举），使 `taskkill` 失败不再卡住调用方。
4. 保证超时结果一定写入会话日志，从恢复路径上消除 `TOOL_OUTCOME_UNKNOWN`。