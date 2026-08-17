# dsh-desktop

English | [中文](README.zh.md)

`dsh-desktop` is the native Windows shell for the DeepSeek Harness Web UI. Its portable package starts one fixed `dsh-web.exe` runtime inside WebView2.

## Build

Prerequisites are Visual Studio 2022 C++ tools, CMake, the WebView2 SDK/runtime, and a checkout of [LunaUI](https://github.com/VincentZe/LunaUI). From the repository root, build the dsh packages first, then run:

```powershell
cd desktop
.\build.ps1 -LunaUiDir <path-to-LunaUI> -WebView2Root <path-to-webview2-sdk>
```

The output is `desktop\build\portable`. It contains `dsh-desktop.exe`, `WebView2Loader.dll`, `config.json`, and `dsh\dsh-web.exe`.

## Fixed runtime

The portable executable embeds the workspace-pinned Cordis runtime and the `dsh-base` plus `dsh-web-app` profile composition. It does not read a user profile, `cordis.patch.yml`, or runtime plugin installation. User settings, credentials, sessions, and WebView data still live under the normal DSH data directories.

Changing Cordis, a bundled plugin, or the fixed profile requires rebuilding the CLI bundle and regenerating the portable package. Adding a plugin to a user profile cannot extend this executable.

The portable configuration launches `dsh\dsh-web.exe --port 0`; no system Node.js installation is required.
