# Agent Note: Preserve native geometry in the desktop window shell

Status: implemented

English | [中文](2026-08-17-desktop-window-chrome-geometry.zh.md)

## Problem

The borderless desktop window renders the React document inside a WebView inset reserved for native resize hit testing. An opaque document background hides the DWM pixels at the rounded corners, the shell wrapper does not provide a stable flex layout for its child, and a restored-state radius remains applied while the native window is maximized. The frameless page also needs a move gesture without turning window controls into drag targets.

## Decision

`DesktopChrome` marks the native shell so `base.css` makes the document background transparent only for the desktop host. Its wrapper is a flex column with explicit width constraints, keeps the rounded clip in restored state, and removes that clip when the native state reports maximized. A primary-button pointer down on a non-interactive page target posts LunaUI's `{ type: "window", action: "drag" }`; buttons, form controls, links, labels, summaries, role buttons, tree items, and explicitly ignored host controls remain interactive. Native resize margins and hit testing stay owned by LunaUI.

## Alternatives considered

**Keep the document opaque and rely on the inner CSS radius.** Rejected: the document still paints the WebView rectangle around the inner shell, so DWM cannot provide the outer rounded pixels.

**Add a separate title bar or custom resize implementation.** Rejected: the desktop composition has no title bar, and LunaUI already owns native resize hit testing and move primitives.

**Change the native resize border to compensate for the page layout.** Rejected: the native eight-pixel inset is the existing resize contract; the regression is in the React wrapper's geometry and presentation.

## Consequences

- Restored windows expose the native rounded frame and resize margin; maximized windows fill their rectangular client area without page-corner gaps.
- Background dragging is available through the existing LunaUI window protocol while common interactive elements do not start a move.
- Browser previews keep their existing document background and do not render native controls because the WebView bridge is absent.

## Testing

`packages/client/web/tests/desktop-chrome.client.spec.tsx` asserts background dragging and interactive-element exclusions. `packages/client/web/tests/base-styles.client.spec.ts` asserts the desktop-only transparent-root rule. TypeScript, the AppRoot/DesktopChrome/base-style Vitest set, the production web build, and the Release `dsh-desktop` target pass.
