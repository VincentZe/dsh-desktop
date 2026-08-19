# Agent Note: Fixed Web SEA dispatches the Windows ACL runner

Status: implemented

[English](2026-08-18-fixed-web-sea-acl-runner-dispatch.md) | 中文

## Problem

固定 Web portable runtime 中，Windows ACL runner 原先按 `[process.execPath, runner.js, ...]` 启动。该 runtime 是 Node SEA executable，因此不会执行 executable 路径后传入的 JavaScript 文件。`--workspace` 等 runner 参数于是穿透到受限命令，并可能被 Git 或其他工具当作自身参数解析。

## Decision

固定 Web 入口识别保留的 `--dsh-windows-acl-runner` 标记，并在进程内用剩余 runner argv 调用 `runWindowsAclRunner()`。`dsh-sandbox-local` 在 SEA 进程中使用 `[process.execPath, --dsh-windows-acl-runner]`；普通 Node 启动继续使用源码或构建后的 JavaScript runner 入口。runner 模块可以安全导入，只有作为直接脚本入口时才自行启动。

该标记会在解析 Web 启动参数前被消费。runner 仍按原有顺序接收 `--workspace`、`--temp`、`--mode`、可选 capability SID、`--` 和调用方命令；任何 runner 参数都不会追加到调用方命令中。

## Alternatives considered

**额外发布一个 runner executable。** 不采用，因为固定 Web SEA 已经包含 runner 实现，额外 executable 会增加打包、版本和部署漂移。

**从调用方命令中删除 `--workspace`。** 不采用，因为这会掩盖 argv 所属层级错误，并可能破坏调用方确实需要同名参数的命令。

**继续把 `runner.js` 传给 SEA executable。** 不采用，因为 Node SEA 会把该路径当作普通参数，而不会将其作为脚本入口执行。

## Verification

dispatch 测试覆盖 SEA 与源码两种 argv 布局。local sandbox 测试覆盖固定 runtime 的 runner 前缀，并确认 marker 位于 `--workspace` 之前。TypeScript 构建与 Windows ACL runner 套件覆盖可导入 runner 路径和既有 ACL 行为。portable 构建还必须通过固定 executable 实际运行 Git 命令，并确认 Git 不会收到 `--workspace`，才能完成现场验证。

## Consequences

- portable 固定 Web runtime 使用一个 executable 同时承载 Web 启动和 Windows ACL runner 分发。
- marker 是保留的进程参数，不得转发给 Web 启动参数或受限命令。
- 源码开发保留直接 `runner.js` 路径，因此本地测试和非 SEA 部署不依赖固定 Web 入口。
- 该分发代码变更后必须重新生成 portable artifact。
