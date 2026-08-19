# Agent Note: Recycle conversations through a durable seven-day bin

Status: implemented

English | [中文](2026-08-18-session-recycle-bin.zh.md)

## Problem

The workspace browser could hide sessions through archive, but it had no user-facing deletion flow that supported recovery or coordinated removal of persisted session logs. A UI-only deletion marker would diverge across tabs and would leave stale cold-session summaries after automatic cleanup.

## Decision

The workspace registry stores an ordered `trashedSessions` record containing each `sessionId` and its `deletedAt` timestamp. Trash, restore, and permanent-delete operations are exposed through the workspace RPC namespace and mirrored by complete-snapshot Host frames.

The client derives a fixed Trash group from the registry snapshot. Ordinary groups, flat mode, search, drag operations, and multi-selection exclude trashed sessions. The browser provides a header selection mode, native checkboxes, a session context menu, restore, and permanent-delete actions.

Persistence exposes a cold-session `remove()` operation backed by JSONL directory removal and SQLite row deletion. The registry runs cleanup at startup and hourly; entries older than seven days are removed when their Session is not live. Physical removal emits `workspace/session-deleted`, and the Host converts that event to `host/session-removed` so connected clients drop the summary for both manual and automatic deletion.

Blank placeholder sessions and subagent sessions are not selectable or deletable from the workspace browser. Workspace accounting stays unchanged while a session is in the Trash group, so restore returns it to its previous group and position.

## Alternatives considered

**Delete the session log immediately.** This would make a context-menu mistake irreversible and would not provide the requested recovery group; the durable marker separates user deletion from physical removal.

**Keep deletion only in browser-local state.** A local marker would not converge across tabs or survive reload; the workspace domain already owns durable grouping state and complete-snapshot frames.

**Dispose a live Agent from the workspace registry.** Agent disposal is an owner-held lifecycle capability, while the registry only has a session id; the registry therefore removes cold logs and defers live entries until their lifecycle ends.

## Verification

Focused UI, Host workspace API, client runtime, workspace registry, and JSONL/SQLite persistence tests cover selection, context-menu actions, restore, permanent deletion, cleanup records, and removal frames. `pnpm run typecheck` passes. The workspace and SQLite suites retain Windows symlink tests that fail with `EPERM` when the current account cannot create directory symlinks.

## Consequences

Deleted sessions remain recoverable for seven days while cold. A live session can remain in the Trash group beyond seven days until its Agent lifecycle ends and a later cleanup pass runs; this preserves the existing Agent ownership contract but means the retention period is a minimum for live sessions rather than a hard upper bound.
