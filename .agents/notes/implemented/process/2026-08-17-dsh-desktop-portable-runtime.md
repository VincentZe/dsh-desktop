# Agent Note: dsh-desktop portable Node runtime

Status: implemented

English | [中文](2026-08-17-dsh-desktop-portable-runtime.zh.md)

## Problem

The desktop shell starts the dsh web server as a child process, but a distributed desktop executable cannot rely on the user's PATH containing Node.js. A mutable profile would also let the desktop package drift away from the Cordis and plugin composition it was built and tested with.

## Decision

`apps/cli` declares the workspace packages required by its production plugin graph as production dependencies. The runtime-closure verifier checks that this graph supplies every required workspace peer. The fixed Web entry resolves exactly the `@deepseek-ai/dsh-base` and `@deepseek-ai/dsh-web-app` patch files shipped with the CLI package; it does not load a profile manifest, a user patch, or a patch watcher.

`desktop/build-runtime.ts` deploys the production dependency closure, materializes workspace links, and packages the fixed Web entry as one Node SEA executable. Native `.node` files and their `.dll` assets are included in the package. `desktop/build.ps1` places that executable at `build/portable/dsh/dsh-web.exe` beside the desktop executable, WebView2 loader, and portable configuration. The portable configuration launches the fixed executable directly; source builds continue to use PATH Node and the dynamic CLI defaults.

The workspace lockfile pins Cordis and the package versions embedded in the executable. Changing Cordis, a bundled plugin, or the fixed composition requires rebuilding the CLI bundle and regenerating the portable package. Runtime profile installation is not an extension mechanism for this package.

## Alternatives considered

**Keep Node and `lib/` beside the desktop executable.** This leaves the plugin graph and fixed profile mutable at runtime, so a deployed shell can run a different composition from the one validated with the desktop build.

**Rely on PATH Node.js.** A fresh machine cannot start the desktop application, and the executable's behavior depends on the launching environment.

**Keep a runtime profile and install plugins after extraction.** That makes the package non-reproducible and reintroduces the profile-resolution failures the fixed bundle is intended to remove.

**Use `pnpm deploy` without declaring workspace peers.** The generated directory can look complete while failing at plugin load time. The explicit production dependency closure and verifier make that failure visible before packaging.

## Verification

The CLI TypeScript build and tsdown bundle complete for both the dynamic launcher and `web-bundle`. A rebuilt fixed executable starts with a clean `DSH_HOME`, emits `dsh web: http://127.0.0.1:<port>`, and serves the Web index with HTTP 200. The desktop Release build completes with the LunaUI framework and the portable directory contains `dsh-desktop.exe`, `dsh/dsh-web.exe`, `WebView2Loader.dll`, and `config.json`.

The native launcher leaves `backend.cli` empty for the fixed executable and resolves only non-empty relative paths. After creating the child process, it closes the parent's inherited pipe writer so an early backend exit reaches the UI with its diagnostics instead of leaving the loading page until the timeout.

## Consequences

The portable package is independent of the machine's Node PATH and starts a reproducible Web composition. The package contains the production dependency closure and is therefore substantially larger than the native executable alone. The fixed profile cannot accept a runtime plugin or profile patch; the release process must regenerate the executable after changes to its Cordis or plugin graph.
