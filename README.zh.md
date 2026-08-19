# dsh-desktop

[English](README.md) | 中文

基于 DeepSeek Harness、[LunaUI](https://github.com/VincentZe/LunaUI) 的 Windows 桌面壳。

![dsh-desktop](assets/readme/img1.jpg)

## 主要改动

- 无边框圆角原生窗口。
- 无需环境配置，但不能装插件。
- 对话管理增强，包括多选、批量操作、回收站保留和模型思考模式配置。
- 可通过 Codex 调用 `dsh-subagent`。

## dsh subagent

直接安装 portable 包内置 `dsh-subagent\SKILL.md`，支持一次性 runner、持久 JSON-RPC runner、workspace 归组、生命周期状态、工具失败摘要和调用方处理交互问题。

更多信息见 [desktop README](desktop/README.md) 和 [subagent 使用手册](docs/cookbook/running-subagent.md)。


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
