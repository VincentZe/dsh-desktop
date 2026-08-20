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

The portable package includes `.agents\skills\dsh-subagent\SKILL.md`, so users do not need to download the skill separately. The package still exposes the Web host only; use the runner entry described by the skill.

## Installing Cordis plugins

Unlike a regular `dsh` installation, the portable package is a **fixed runtime**: `runFixedWebProfile` does not consult `$DSH_HOME/cordis.patch.yml` or any user profile, so a plugin installed via `npm --prefix ~/.dsh install <plugin>` is never loaded. There are three ways to add a plugin to the portable package:

1. **Rebuild the package (official, persistent).** Add the plugin to the runtime composition — a loader entry in `dsh-web-runtime/config/agent-presets/*/agent.cordis.yml` (or a fixed-web patch) plus its package in the pruned closure via `desktop/build-runtime.ts` — then rerun `build.ps1` / `build-runtime.ts`. This is the only supported path; the shipped presets already load this way (see `presetLoaderRoots` in `build-runtime.ts`).
2. **Runtime manual extension (works until the next rebuild).** Drop the plugin package (and its third-party dependencies) into `dsh-web-runtime/node_modules` and add a loader entry to `dsh-web-runtime/config/agent-presets/*/agent.cordis.yml`. Node module resolution walks up from the runtime's own config directory, so the entry resolves. A rebuild of the portable package wipes the sidecar and undoes this.
3. **Session-scoped experiments.** The `cordis` preset's `tool-cordis` can mount a temporary plugin into the live runtime. It is model-driven, non-persistent, and a trust boundary — treat it as shell access.

Constraints:

- **Dependency singletons.** A plugin that pulls its own copy of `@deepseek-ai/*` packages (cordis, tools, session, ...) gets a second instance with mismatched service identities; `ctx.get` cannot reach host services. Plugins must stay self-contained or reuse the runtime's closure.
- **Pruned closure.** `build-runtime.ts` prunes `dsh-web-runtime/node_modules` to the `webRuntimeRoots` + `presetLoaderRoots` closure plus static imports. Third-party dependencies of a plugin are not inside it and must be shipped alongside the plugin (option 2) or added to the closure (option 1).

Release follow-up: the current portable build can retain absolute build and source paths in embedded Web runtime strings. They do not include user sessions or credentials, but should be removed before treating a future public package as fully sanitized.
