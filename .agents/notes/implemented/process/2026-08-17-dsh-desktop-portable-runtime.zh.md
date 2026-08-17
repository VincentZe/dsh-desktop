# Agent Note: dsh-desktop 旁置 Node 运行时

Status: implemented

[English](2026-08-17-dsh-desktop-portable-runtime.md) | 中文

## Problem

桌面壳会把 dsh web 服务作为子进程启动，但发布的桌面程序不能依赖用户的 PATH 中存在 Node.js。可变 profile 还会让桌面包偏离构建和验证时使用的 Cordis 与插件组合。

## Decision

`apps/cli` 将生产插件图所需的 workspace 包声明为生产依赖。runtime-closure 检查器验证这张图提供了所有必需的 workspace peer。固定 Web 入口只解析随 CLI 包交付的 `@deepseek-ai/dsh-base` 和 `@deepseek-ai/dsh-web-app` patch 文件；它不会加载 profile manifest、用户 patch 或 patch watcher。

`desktop/build-runtime.ts` 部署生产依赖闭包、物化 workspace links，并将固定 Web 入口打包为一个 Node SEA executable。原生 `.node` 文件及其 `.dll` 资产也会纳入包中。`desktop/build.ps1` 将该 executable 放到 `build/portable/dsh/dsh-web.exe`，并把桌面程序、WebView2 loader 和 portable 配置放在旁边。portable 配置直接启动固定 executable；源码构建继续使用 PATH 中的 Node 和动态 CLI 默认值。

workspace lockfile 锁定了嵌入 executable 的 Cordis 与各包版本。修改 Cordis、组合包内插件或固定组合后，必须重新构建 CLI bundle 并重新生成 portable 包。运行时 profile 安装不是这个包的扩展机制。

## Alternatives considered

**在桌面 executable 旁放置 Node 和 `lib/`。** 这样插件图和固定 profile 在运行时仍可变，部署后的壳可能运行与桌面构建一起验证的组合不同。

**依赖 PATH 中的 Node.js。** 新机器无法启动桌面程序，程序行为也会依赖启动环境。

**保留运行时 profile 并在解压后安装插件。** 这样会使包不可复现，并重新引入固定 bundle 要消除的 profile 解析失败。

**在没有声明 workspace peer 的情况下直接使用 `pnpm deploy`。** 生成目录可能看起来完整，却会在插件加载时失败。显式的生产依赖闭包和检查器会在打包前暴露这类问题。

## Verification

CLI TypeScript 构建和 tsdown bundle 都能为动态 launcher 与 `web-bundle` 完成构建。重新生成的固定 executable 能在干净的 `DSH_HOME` 下启动，输出 `dsh web: http://127.0.0.1:<port>`，并以 HTTP 200 提供 Web 首页。LunaUI 框架参与的桌面 Release 构建完成，portable 目录包含 `dsh-desktop.exe`、`dsh/dsh-web.exe`、`WebView2Loader.dll` 和 `config.json`。

native 启动器对固定 executable 保持空的 `backend.cli`，只解析非空的相对路径。创建子进程后，启动器会关闭自己继承的管道写端，使后端提前退出时能够把诊断信息送回 UI，而不会让加载页面一直停留到超时。

## Consequences

portable 包不再依赖机器的 Node PATH，并启动可复现的 Web 组合。包内包含生产依赖闭包，因此会明显大于单独的 native executable。固定 profile 不接受运行时插件或 profile patch；其 Cordis 或插件图发生变化后，发布流程必须重新生成 executable。
