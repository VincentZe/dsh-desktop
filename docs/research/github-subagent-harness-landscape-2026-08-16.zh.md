# GitHub 上的 DSH 外部 Agent 包装调研

[English](github-subagent-harness-landscape-2026-08-16.md) | 中文

日期：2026-08-16

## 问题

是否已经有人把 DeepSeek Harness（DSH）包装成其他 agent 工具可以直接启动的 subagent、ACP agent 或统一 CLI。

## 结论

已经有人在做，而且社区实现主要收敛到 ACP，而不是直接包装 `dsh --profile headless` 的纯文本 stdout。当前没有看到一个已经形成共识、由上游官方交付的统一 `dsh subagent` CLI；但已有多个可安装的第三方包装器和 profile bundle，正好补上安装、配置、凭据、编辑器注册和 ACP 能力暴露这一层。

本次只做了 GitHub 一手来源的静态核验，没有安装或运行这些外部项目，也没有验证它们当前 npm 发布物与仓库源码完全一致。

## 直接相关的实现

### `asteroida123/dsh-codeg-adapter`

这是最接近“薄包装”的实现。README 明确说明它不实现 ACP 能力，而是把官方 `@deepseek-ai/dsh-acp` 与 `@deepseek-ai/dsh-acp-demo` 收成一个可安装命令 `dsh-codeg`。它固定 DSH rc 版本，读取环境或 `.env` 中的 `DEEPSEEK_API_KEY`，按绝对路径传入内置 `cordis.yml`，并提供 Codeg 注册配置。`bin/dsh-codeg.js` 实际 spawn Node、`@deepseek-ai/dsh-acp-demo/bin` 和 bundled config。

- README：https://github.com/asteroida123/dsh-codeg-adapter/blob/main/README.md
- package metadata：https://github.com/asteroida123/dsh-codeg-adapter/blob/main/package.json
- launcher：https://github.com/asteroida123/dsh-codeg-adapter/blob/main/bin/dsh-codeg.js

判断：已把“安装一串 DSH 包并手写配置”包装成了面向一个外部 agent 客户端的安装与启动入口；功能仍依赖官方 automation-only ACP 能力。

### `devloom1024/dsh-acp-gateway`

这是更完整的第三方 ACP 产品化实现。README 提供 `npx -y dsh-acp-gateway` 一条命令、Zed/VS Code ACP 配置、独立或 offline archive 分发、ACP registry JSON，以及 sessions、streaming、tool calls、agent presets、model/permission 配置等能力。`package.json` 声明了可执行 bin；`src/index.ts` 暴露 Cordis 插件并实现 ACP 请求处理、会话管理、通知和 bridge script 生成。

- README：https://github.com/devloom1024/dsh-acp-gateway/blob/main/README.md
- package metadata：https://github.com/devloom1024/dsh-acp-gateway/blob/main/package.json
- gateway source：https://github.com/devloom1024/dsh-acp-gateway/blob/main/src/index.ts
- registry entry：https://github.com/devloom1024/dsh-acp-gateway/blob/main/registry.json

判断：它已经把 DSH runtime、ACP server、分发入口和编辑器注册整合成一个产品形态，但这是第三方独立实现，不代表上游 DSH 已采用它。

### `cnctem/dsh-acp`

这是 profile bundle 路线。README 给出 `dsh plugin --profile acp add github:cnctem/dsh-acp` 安装方式，然后让 Zed 启动 `dsh --profile acp`。项目声明基于官方 ACP skeleton，增加 token/thinking streaming、tool cards、session history、model/thinking selectors、presets、terminal、usage 和 elicitation。

- README：https://github.com/cnctem/dsh-acp/blob/main/README.md
- package metadata：https://github.com/cnctem/dsh-acp/blob/main/package.json

判断：它复用了 DSH 自己的 profile/plugin 分发机制，正是“已有底层，但需要一个可安装 profile 和客户端入口”的做法。

### `grunmin/dsh-acp-enhanced`

这是另一个 profile/plugin 路线，README 称其为官方 `@deepseek-ai/dsh-acp` 的 drop-in replacement，并提供 `dsh plugin --profile acp-enhanced add dsh-acp-enhanced`、Zed launcher、streaming、telemetry、model/permission control、session management、MCP 和 plan 等编辑器能力。`package.json` 声明了 `dsh.bundle.patch`，说明它按 DSH bundle 约定安装。

- README：https://github.com/grunmin/dsh-acp-enhanced/blob/main/README.md
- package metadata：https://github.com/grunmin/dsh-acp-enhanced/blob/main/package.json

判断：目标和上一个项目相同，重点是把 automation-only ACP 补成面向编辑器的体验。

### `xintaofei/deepseek-acp`

这是独立的 `deepseek-acp` ACP executable。README 明确区分官方 automation-only bridge 与其面向编辑器的完整 agent，并提供 `npx deepseek-acp`、`npm i -g deepseek-acp`、Zed 和 Codeg 注册方式。它声称提供逐 token 输出、工具卡片、diff、终端、计划、session load/list、model/permission selectors、MCP 和 usage 等功能。

- README：https://github.com/xintaofei/deepseek-acp/blob/main/README.md

判断：这是“把 DSH 做成可被 ACP 编辑器直接拉起的独立 agent binary”的路线；本次没有进一步运行其 npm 包或完整测试套件。

### `zhiyuchen1101/codewhale-dsh`

这是反向桥接例子：CodeWhale 通过 MCP 暴露 `dsh_init`、`dsh_status`、`dsh_read`、`dsh_cancel` 和 `dsh_respond`，后台启动 DSH headless，并在后续 roadmap 中接入官方 ACP streaming。它不是通用的 DSH CLI，而是一个特定外部 agent 的 worker bridge。

- README：https://github.com/zhiyuchen1101/codewhale-dsh/blob/main/README.md

判断：它证明“外部 agent 通过协议桥调用 DSH headless”已有实际实现；但接口是 CodeWhale 专用 MCP，不是通用 subagent API。

## 未计入的项目

GitHub 搜索还返回大量 DSH 插件、监控面板、UI、agent preset 和 subagent provider。它们增强 DSH 内部能力，但没有提供一个外部 agent 可直接启动的 ACP/JSON-RPC/CLI 入口，因此没有算作本问题的直接实现。

## 对本仓库的含义

“底层能力已经有、产品包装不足”的判断基本得到外部实现印证：

1. 最小包装层是一个 npm/npx launcher，负责依赖、版本、凭据、绝对配置路径和客户端注册。
2. 更完整的包装层是可安装 profile/bundle，暴露 `dsh --profile acp`，并负责编辑器需要的 streaming、tool calls、session 管理、权限和模式选择。
3. 社区主要选择 ACP，因为它比 headless stdout 更适合跨 agent/IDE 的进程协议；plain CLI 仍适合一次性 worker，但不是完整的 subagent transport。
4. 目前这些项目大多是新近更新、低 star 或独立第三方实现，尚不能视为成熟的生态标准。上游是否接受、维护或合并它们，需要单独确认。

## 搜索与证据边界

初始 GitHub repository search 使用了 `deepseek-harness subagent`、`dsh DeepSeek agent` 和 `DeepSeek ACP agent` 等查询；随后逐个读取候选仓库的 GitHub README、`package.json`、launcher、plugin source 和 registry 文件。GitHub API 在后续查询中触发未认证 rate limit，因此没有把 API 搜索结果当作穷尽性统计；本报告只保留已经打开并核对过的一手仓库内容。
