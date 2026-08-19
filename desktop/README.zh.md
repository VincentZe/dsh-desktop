# dsh-desktop

[English](README.md) | 中文

`dsh-desktop` 是 DeepSeek Harness Web UI 的原生 Windows 壳。portable 包会在 WebView2 内启动一个固定的 `dsh-web.exe` runtime。

## 构建

依赖 Visual Studio 2022 C++ 工具、CMake、WebView2 SDK/runtime 和 [LunaUI](https://github.com/VincentZe/LunaUI) 检出目录。在仓库根目录先构建 dsh packages，然后执行：

```powershell
cd desktop
.\build.ps1 -LunaUiDir <path-to-LunaUI> -WebView2Root <path-to-webview2-sdk>
```

产物位于 `desktop\build\portable`，包含 `dsh-desktop.exe`、`WebView2Loader.dll`、`config.json`、`dsh\dsh-web.exe` 以及 `dsh\dsh-web-runtime\` 固定 runtime 包。

## 固定 runtime

固定 runtime 由小型 Node SEA bootstrap 和经过剪枝的 sidecar 组成，sidecar 包含 workspace 锁定的 Cordis runtime，以及 `dsh-base` 加 `dsh-web-app` 的固定 profile 组合。它不会读取用户 profile、`cordis.patch.yml` 或运行时插件安装；用户设置、凭据、会话和 WebView 数据仍写入正常的 DSH 数据目录。

修改 Cordis、组合包内插件或固定 profile 后，必须重新构建 CLI bundle 并重新生成 portable 包。只有 sidecar 组合变化时可以复用 bootstrap，但必须和 sidecar 一起发布。向用户 profile 添加插件不会扩展这个 runtime。

portable 配置启动 `dsh\dsh-web.exe --port 0`，目标机器不需要安装系统 Node.js。

发布后续事项：当前 portable 构建可能在内置 Web runtime 字符串中保留构建机和源码绝对路径。它不包含用户会话或凭据，但在将后续版本作为完全清理过的公开包发布前，应移除这些路径。
