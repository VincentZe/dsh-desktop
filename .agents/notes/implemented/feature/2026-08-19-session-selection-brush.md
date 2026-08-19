# Agent Note: Brush-select visible sessions with a held pointer

Status: implemented

English | [中文](2026-08-19-session-selection-brush.zh.md)

## Problem

Multi-selection required a separate click for every Session row, which made selecting a contiguous set slow and caused unnecessary pointer travel.

## Decision

Selection mode owns a transient pointer brush. A primary-pointer press with `Shift` or `Ctrl` on a selectable Session row records the origin and the operation, immediately includes or removes the origin, and selects every crossed visible row. `Shift` adds to the current selection, while `Ctrl` removes from it; a press without either modifier keeps the normal row click or reorder-drag behavior. The synthetic click generated after a brush gesture is suppressed, while a plain click in selection mode keeps the existing single-row toggle behavior.

Checkboxes, row menus, and other row action controls do not start a brush. Trash rows and blank placeholder rows remain outside the brush, and releasing or cancelling the pointer clears its transient state.

## Alternatives considered

**Use a mode-only brush.** A mode that captures every primary drag prevents normal Session reorder; requiring `Shift` or `Ctrl` for the brush keeps reorder available without a modifier.

**Use a delayed long-press timer.** A timer adds an arbitrary delay before a gesture becomes useful and makes a normal click feel less direct; a modifier-held primary pointer is sufficient to distinguish brush selection from a click.

**Implement range selection from the origin to the current row.** Grouped and flat views can reorder independently and do not share one contiguous account, so selecting rows as the pointer enters them matches what the user visibly traverses without imposing hidden ordering semantics.

**Toggle every crossed row.** Toggling would make the result depend on the existing selection and would unexpectedly deselect rows; explicit union and subtraction operations make the gesture predictable.

## Verification

`packages/client/ui-workspace/tests/workspace-browser.client.spec.tsx` covers direct `Shift` brushing, `Shift` union, `Ctrl` subtraction, no-modifier drag preservation, post-gesture click suppression, and plain single-row toggling. The focused WorkspaceBrowser and Rows suites pass 46 and 26 tests, including the modifier-before-native-drag regression, the tree suite passes, and `pnpm run typecheck` passes.

## Consequences

The behavior applies to grouped and flat Session lists and only reaches rows currently rendered and entered by the pointer. A Shift or Ctrl brush enters selection mode; ordinary Session reorder remains available without either modifier, and modifier-held drags are cancelled before they reach the reorder handler. Users who need to make a small adjustment continue to use individual row clicks or checkboxes.
