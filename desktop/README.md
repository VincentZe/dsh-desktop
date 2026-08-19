# dsh-desktop

English | [中文](README.zh.md)

`dsh-desktop` is the native Windows shell for the DeepSeek Harness Web UI. Its portable package starts one fixed `dsh-web.exe` runtime inside WebView2.

## Build

Prerequisites are Visual Studio 2022 C++ tools, CMake, the WebView2 SDK/runtime, and a checkout of [LunaUI](https://github.com/VincentZe/LunaUI). From the repository root, build the dsh packages first, then run:

```powershell
cd desktop
.\build.ps1 -LunaUiDir <path-to-LunaUI> -WebView2Root <path-to-webview2-sdk>
```

The output is `desktop\build\portable`. It contains `dsh-desktop.exe`, `WebView2Loader.dll`, `config.json`, `dsh\dsh-web.exe`, and the fixed runtime package under `dsh\dsh-web-runtime\`.

## Fixed runtime

The fixed runtime consists of a small Node SEA bootstrap plus a pruned sidecar containing the workspace-pinned Cordis runtime and the `dsh-base` plus `dsh-web-app` profile composition. It does not read a user profile, `cordis.patch.yml`, or runtime plugin installation. User settings, credentials, sessions, and WebView data still live under the normal DSH data directories.

Changing Cordis, a bundled plugin, or the fixed profile requires rebuilding the CLI bundle and regenerating the portable package. The bootstrap can remain unchanged when only the sidecar composition changes, but the sidecar must be shipped with it. Adding a plugin to a user profile cannot extend this runtime.

The portable configuration launches `dsh\dsh-web.exe --port 0`; no system Node.js installation is required.

Release follow-up: the current portable build can retain absolute build and source paths in embedded Web runtime strings. They do not include user sessions or credentials, but should be removed before treating a future public package as fully sanitized.
