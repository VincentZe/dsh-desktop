# Agent Note: 隔离桌面打包与源码 workspace

Status: implemented

[English](2026-08-17-desktop-pkg-outside-workspace.md) | 中文

## Problem

固定 Web 打包命令会为 monorepo 的 CLI 包执行 production `pnpm deploy`。legacy deploy 实现可能针对源码 workspace 运行 production 依赖状态修复；在非交互式打包进程中，这可能在删除 `node_modules` 时中止，使源码 runner 在连接 Web host 之前就无法启动。

## Decision

打包流程会把源码输入复制到临时 workspace，排除生成的 desktop 输出、`.git` 以及所有 `node_modules` 目录。`pnpm deploy` 从这个副本运行，并通过绝对路径写入真实 staging。复制的 workspace 会在 `pkg` 运行前删除；`pnpm dlx pkg` 也从仓库父目录运行。源码 workspace 不再成为 install 目标，同时部署包仍使用同一份 manifest、lockfile、已构建 JavaScript 和包资源。

## Alternatives considered

**设置 `confirmModulesPurge=false`，继续从仓库根目录运行。** 这会绕过非交互式提示，却允许打包命令修改源码 workspace 的依赖树，因此只是隐藏耦合，并未移除耦合。

**使用 `npx` 运行 pkg。** 第二套包管理器路径会引入独立的缓存和配置面。现有 pnpm 缓存足够使用，只需让命令在 workspace 外运行。

**在这次改动中把 supervisor runner 加入 portable executable。** runner 与固定 Web host 有不同的生命周期和依赖约定。打包隔离解决了已观察到的源码 runner 启动失败；独立 runner 分发仍是另一个产品决策。

## Consequences

重新生成桌面包时，deploy 和 pkg 步骤都不会再触发源码 workspace 的 production install。portable 包仍只包含固定 Web host 与 native shell；源码 `dsh-subagent` 调用仍由仓库 runner 负责，并需要仓库依赖。

## Testing

通过重建 runtime 后，从源码 workspace 直接运行 runner，确认没有触发依赖修复；pkg 仍从仓库父目录运行。portable 包内容仍是固定 Web host 与 native shell；独立 runner 仍是另一个产品决策。
