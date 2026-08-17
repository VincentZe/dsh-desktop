# Agent Note: Keep interactive tree items out of native window dragging

Status: implemented

English | [中文](2026-08-17-desktop-treeitem-drag-interception.zh.md)

## Problem

`DesktopChrome` starts a native window move for primary pointer presses outside its drag-ignore selector. Workspace and session rows are `role="treeitem"` elements with local click handlers, so a row press could also start a window move and prevent reliable session selection.

## Decision

`DesktopChrome` treats `[role="treeitem"]` as an interactive target alongside buttons, form controls, links, and other ignored host controls. The page background remains the native move target, while workspace and session row clicks stay in the WebView and reach their local handlers.

## Alternatives considered

**Stop propagation from every workspace and session row.** Rejected: this spreads knowledge of the native window protocol across feature-owned components and leaves future interactive rows exposed to the same defect.

**Require an explicit drag-region attribute on the page background.** Rejected: it changes the existing background-drag behavior and requires annotating the full shell instead of extending the existing interactive-target rule.

## Consequences

- Session and workspace rows can select or expand without sending a native `window/drag` message.
- Native dragging remains available from non-interactive page background regions.
- New interactive composite rows must expose an ignored semantic role or `data-host-drag-ignore="true"` when they are not already covered by the selector.

## Testing

`packages/client/web/tests/desktop-chrome.client.spec.tsx` verifies that a tree-item click invokes its local handler without a native drag message. The focused DesktopChrome suite passes `4/4`, the WorkspaceBrowser suite passes `40/40`, the production build completes, and the rebuilt fixed Web executable serves the index with HTTP `200`.
