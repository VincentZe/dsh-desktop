# Agent Note: Declare native window drag containers below the shell

Status: implemented

English | [中文](2026-08-19-declared-window-drag-containers.zh.md)

## Problem

An absolute transparent layer across the window top can intercept pointer events intended for page controls such as search, session navigation, and header actions.

## Decision

`DesktopChrome` listens at the window shell and starts a native move only when the pointer target is inside `[data-dsh-window-drag="true"]`. Buttons, links, form controls, common interactive ARIA roles, editable content, tree items, and `[data-host-drag-ignore="true"]` descendants remain page-owned. The sidebar logo row and the conversation session header declare the drag containers; the conversation list and transcript do not. When a drag container is present, the shell paints a thin inner top outline and a downward-fading inset glow without participating in hit testing.

## Alternatives considered

**Keep an absolute top overlay.** It gives a large hit area but changes the browser hit target and can block controls rendered beneath it.

**Make the whole window draggable with opt-outs.** This makes every new interactive surface depend on remembering an exclusion rule and can capture scrolling or row gestures.

**Attach separate native handlers in each UI package.** This duplicates WebView2 protocol knowledge and makes lifecycle behavior vary between surfaces; the shell owns dispatch while UI packages only declare eligible containers.

## Verification

The focused DesktopChrome, sidebar, and conversation suites pass 27 tests. `pnpm run typecheck`, `pnpm run build:lib:client`, `pnpm run build:web`, and `git diff --check` pass.

## Consequences

Empty space in the declared sidebar top row and conversation header can move the native window. The same top-bar affordance provides a subtle outline and inset glow across the inner window edge. Page controls in those containers keep their normal pointer behavior, and future draggable surfaces opt in by declaring the data attribute while keeping their interactive descendants explicit.
