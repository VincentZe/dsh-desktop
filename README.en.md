# dsh-desktop

English | [中文](README.md)

Windows desktop shell for DeepSeek Harness and [LunaUI](https://github.com/VincentZe/LunaUI).

![dsh-desktop](assets/readme/img1.jpg)

## Highlights

- The portable package is 64 MB.
- Runs as a standalone window.
- No environment setup is required; plugins require a package rebuild (see Cordis plugins below).
- Conversation management improvements including multi-select, batch operations, recycle-bin retention, and model thinking-mode configuration.
- `dsh-subagent` can be called from Codex.

## dsh subagent

Install the portable package directly; it includes `dsh-subagent\SKILL.md`. It supports one-shot and persistent JSON-RPC runners, workspace grouping, lifecycle status, tool-error summaries, and caller-controlled interactions.

More details: [desktop README](desktop/README.md) and [subagent cookbook](docs/cookbook/running-subagent.md).
## Cordis plugins

The portable package is a fixed runtime: it does not read `$DSH_HOME/cordis.patch.yml` or any user profile, so plugins installed with `npm --prefix ~/.dsh` are never loaded. Extending the runtime requires rebuilding the package (see "Installing Cordis plugins" in the [desktop README](desktop/README.md)); the `cordis` preset's `tool-cordis` supports session-scoped temporary mounts. Constraints: a plugin's `@deepseek-ai/*` dependencies must reuse the runtime closure (avoiding duplicate instances), and third-party dependencies must ship with the plugin.

## Run

### Run from source

```powershell
pnpm install
pnpm run build
pnpm dsh web
```

### Build portable desktop

```powershell
cd desktop
.\build.ps1 -LunaUiDir <path-to-LunaUI> -WebView2Root <path-to-webview2-sdk>
```

The portable output is `desktop\build\portable`.
