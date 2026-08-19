# Agent Note: Start native resize from the visible page edge

Status: implemented

English | [中文](2026-08-19-page-edge-resize-handles.zh.md)

## Problem

The native resize hit test used the outer transparent window rectangle while the WebView and visible rounded page were inset for the shadow, so the resize cursor and trigger sat outside the visible page edge. The page action also stopped at interactive descendants, even though the edge is reserved for resizing.

## Decision

LunaUI keeps the WebView inset but exposes `native_resize_hit_test` so a page can disable the transparent native outer-ring hit test. dsh-desktop disables that path and `DesktopChrome` delegates resize from the top-level visible shell edge to the existing `window` action protocol. The edge is treated as a dedicated resize strip, so its geometry takes priority over descendants rendered underneath it. Directional edge and corner cursors remain visible on the shell and its descendants. A non-interactive pointer-following border glow indicates the hovered edge, a stronger inner glow indicates an active resize, and the native `interaction-ended` lifecycle event clears the active state after the modal resize loop exits.

## Alternatives considered

**Move the native hit test inward.** The native window does not know which visible page elements are interactive, and moving the hit test inward would continue to make a native layer compete with page controls.

**Set `resize_border` to zero.** This would remove the transparent inset needed by the rounded shadow and would couple visual presentation to resize policy.

**Install eight transparent page overlays.** Separate overlays would create new hit-test surfaces over headers and controls; root-level event delegation keeps the edge geometry in one place without adding overlay elements.

## Verification

The focused DesktopChrome and style suites pass 10 tests. `pnpm run build:web`, `pnpm run typecheck`, `cmake --build desktop/build --config Release --target dsh-desktop`, the LunaUI Debug libraries and tests, the LunaUI runtime test, and CTest with the WebView2 SDK bin directory on `PATH` pass.

## Consequences

The visible rounded page edge owns resize initiation, while the transparent outer ring remains available for shadow rendering. Maximized windows do not start page resize. Future LunaUI consumers can keep the default native hit test or set `native_resize_hit_test` to false when their page owns edge actions.
