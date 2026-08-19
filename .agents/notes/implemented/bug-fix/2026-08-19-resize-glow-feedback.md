# Agent Note: Follow the native resize pointer in page feedback

Status: implemented

English | [中文](2026-08-19-resize-glow-feedback.zh.md)

## Problem

The visible page owns resize initiation while Windows owns the modal sizing loop. WebView pointer events stop during that loop, so an active resize glow stays at its initial pointer position. The top drag affordance also appeared whenever a drag container existed, and page overlays could paint above the glow.

## Decision

LunaUI forwards host client-area mouse coordinates as `windowResizePointer` messages while a window is in `WM_ENTERSIZEMOVE`/`WM_EXITSIZEMOVE`. `DesktopChrome` converts those physical coordinates with the current device-pixel ratio and updates the same pointer variables used by normal page hover. The top affordance is shown only while a declared drag container is hovered. Resize feedback uses an inner border glow masked by a pointer-following radial mask five times larger than the visible halo, and its non-interactive layer is above application content.

## Verification

The focused DesktopChrome suites cover hover-only drag feedback, native pointer coordinate conversion, and resize lifecycle cleanup. The LunaUI lifecycle test covers the serialized native pointer message. `pnpm run typecheck`, `pnpm run build:web`, the focused frontend tests, `cmake --build build --config Debug --target luna_ui_lifecycle_test`, and `ctest --test-dir build -C Debug -R luna_ui_lifecycle_test --output-on-failure` pass.

## Consequences

Resize feedback remains visible and follows the pointer during native resizing without adding a page hit-test layer. Application controls retain pointer ownership because the feedback layer has `pointer-events: none`; native window controls stay above the feedback layer.
