# dsh-desktop

[English](README.en.md) | 中文

基于 DeepSeek Harness、[LunaUI](https://github.com/VincentZe/LunaUI) 的 Windows 桌面壳。

![dsh-desktop](assets/readme/img1.jpg)

## 主要改动

- 便携包64MB。
- 独立窗口。
- 无需环境配置；插件需要重新打包（见下方 Cordis 插件）。
- 对话管理增强，包括多选、批量操作、回收站保留和模型思考模式配置。
- 可通过 Codex 调用 `dsh-subagent`。

## dsh subagent

直接安装 portable 包内置 `dsh-subagent\SKILL.md`，支持一次性 runner、持久 JSON-RPC runner、workspace 归组、生命周期状态、工具失败摘要和调用方处理交互问题。

更多信息见 [desktop README](desktop/README.md) 和 [subagent 使用手册](docs/cookbook/running-subagent.md)。
## Cordis 插件

portable 是固定 runtime：不读取 `$DSH_HOME/cordis.patch.yml` 或用户 profile，`npm --prefix ~/.dsh` 安装的插件不会被加载。扩展插件需要重新打包（详见 [desktop README](desktop/README.md) 的 "Installing Cordis plugins"）；`cordis` preset 的 `tool-cordis` 支持会话级临时挂载。限制：插件的 `@deepseek-ai/*` 依赖必须复用运行时闭包（避免双实例），第三方依赖需随包提供。


## 运行

### 从源码运行

```powershell
pnpm install
pnpm run build
pnpm dsh web
```

### 构建 portable desktop

```powershell
cd desktop
.\build.ps1 -LunaUiDir <path-to-LunaUI> -WebView2Root <path-to-webview2-sdk>
```

portable 产物位于 `desktop\build\portable`。
