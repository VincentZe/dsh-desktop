# dsh-desktop

[English](README.md) | 中文

`dsh-desktop` 是 DeepSeek Harness Web UI 的原生 Windows 壳。portable 包会在 WebView2 内启动一个固定的 `dsh-web.exe` runtime。

## 构建

依赖 Visual Studio 2022 C++ 工具、CMake、WebView2 SDK/runtime 和 [LunaUI](https://github.com/VincentZe/LunaUI) 检出目录。在仓库根目录先构建 dsh packages，然后执行：

```powershell
cd desktop
.\build.ps1 -LunaUiDir <path-to-LunaUI> -WebView2Root <path-to-webview2-sdk>
```

产物位于 `desktop\build\portable`，包含 `dsh-desktop.exe`、`WebView2Loader.dll`、`config.json` 和 `dsh\dsh-web.exe`。

## 固定 runtime

portable executable 内置 workspace 锁定的 Cordis runtime，以及 `dsh-base` 加 `dsh-web-app` 的固定 profile 组合。它不会读取用户 profile、`cordis.patch.yml` 或运行时插件安装；用户设置、凭据、会话和 WebView 数据仍写入正常的 DSH 数据目录。

修改 Cordis、组合包内插件或固定 profile 后，必须重新构建 CLI bundle 并重新生成 portable 包。向用户 profile 添加插件不会扩展这个 executable。

portable 配置启动 `dsh\dsh-web.exe --port 0`，目标机器不需要安装系统 Node.js。
