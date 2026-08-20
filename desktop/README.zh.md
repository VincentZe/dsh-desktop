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

portable 包内置 `.agents\skills\dsh-subagent\SKILL.md`，用户不需要单独下载 skill。该包仍然只提供 Web host；runner 入口以 skill 中的说明为准。

## 安装 Cordis 插件

与常规 `dsh` 安装不同，portable 包是**固定 runtime**：`runFixedWebProfile` 不读取 `$DSH_HOME/cordis.patch.yml` 或任何用户 profile，因此通过 `npm --prefix ~/.dsh install <plugin>` 安装的插件永远不会被加载。向 portable 包添加插件有三种方式：

1. **重新打包（官方途径，持久生效）。** 把插件加入 runtime 组合——在 `dsh-web-runtime/config/agent-presets/*/agent.cordis.yml`（或 fixed-web patch）加 loader entry，并通过 `desktop/build-runtime.ts` 把插件包纳入剪枝闭包——然后重跑 `build.ps1` / `build-runtime.ts`。这是唯一受支持的路径；内置 preset 就是这么加载的（见 `build-runtime.ts` 的 `presetLoaderRoots`）。
2. **运行时手动扩展（下次重建前有效）。** 把插件包（及其第三方依赖）放进 `dsh-web-runtime/node_modules`，并在 `dsh-web-runtime/config/agent-presets/*/agent.cordis.yml` 加 loader entry。Node 模块解析会从 runtime 自身配置目录向上查找，因此 entry 可以解析。重建 portable 包会清空 sidecar 并撤销此改动。
3. **会话级实验。** `cordis` preset 的 `tool-cordis` 可以把临时插件挂载进运行中的 runtime。它是模型驱动的、不持久，且属于信任边界——视同 shell 访问。

限制：

- **依赖单例。** 插件若自带一份 `@deepseek-ai/*` 依赖（cordis、tools、session 等），会出现第二份实例，服务身份不匹配，`ctx.get` 无法触达宿主服务。插件必须自包含或复用 runtime 闭包。
- **闭包剪枝。** `build-runtime.ts` 会把 `dsh-web-runtime/node_modules` 剪枝到 `webRuntimeRoots` + `presetLoaderRoots` 闭包加静态 import。插件的第三方依赖不在其中，必须随插件一起提供（方式 2）或加入闭包（方式 1）。

发布后续事项：当前 portable 构建可能在内置 Web runtime 字符串中保留构建机和源码绝对路径。它不包含用户会话或凭据，但在将后续版本作为完全清理过的公开包发布前，应移除这些路径。
