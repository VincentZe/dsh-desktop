# Agent Note: Brush-select visible sessions with a held pointer

Status: implemented

English | [中文](2026-08-19-session-selection-brush.zh.md)

## Problem

Multi-selection required a separate click for every Session row, which made selecting a contiguous set slow and caused unnecessary pointer travel.

## Decision

Selection mode owns a transient pointer brush. A primary-pointer press on a selectable Session row records the origin and the operation. The first crossed row replaces the current selection without a modifier, adds to it with `Shift`, or removes from it with `Ctrl`; later crossed rows use the same operation. The synthetic click generated after a moved gesture is suppressed, while a plain click keeps the existing single-row toggle behavior.

Checkboxes, row menus, and other row action controls do not start a brush. Trash rows and blank placeholder rows remain outside the brush, and releasing or cancelling the pointer clears its transient state.

## Alternatives considered

**Use a delayed long-press timer.** A timer adds an arbitrary delay before a gesture becomes useful and makes a normal click feel less direct; the held primary pointer is sufficient to distinguish brush selection from a click.

**Implement range selection from the origin to the current row.** Grouped and flat views can reorder independently and do not share one contiguous account, so selecting rows as the pointer enters them matches what the user visibly traverses without imposing hidden ordering semantics.

**Toggle every crossed row.** Toggling would make the result depend on the existing selection and would unexpectedly deselect rows; explicit replace, add, and remove operations make the gesture predictable.

## Verification

`packages/client/ui-workspace/tests/workspace-browser.client.spec.tsx` covers replace, `Shift` union, `Ctrl` subtraction, post-gesture click suppression, and plain single-row toggling. The focused WorkspaceBrowser suite passes 46 tests, the related Rows and tree suites pass 50 tests, and `pnpm run typecheck` passes.

## Consequences

The behavior applies to grouped and flat Session lists and only reaches rows currently rendered and entered by the pointer. Selection gestures remain in selection mode so ordinary Session drag-reordering keeps its existing meaning. Users who need to make a small adjustment continue to use individual row clicks or checkboxes.
