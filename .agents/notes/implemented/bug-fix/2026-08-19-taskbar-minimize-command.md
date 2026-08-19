# Agent Note: Preserve taskbar minimize commands for borderless windows

Status: implemented

English | [中文](2026-08-19-taskbar-minimize-command.zh.md)

## Problem

The borderless dsh-desktop window was visible in the taskbar but did not expose the native minimize command, so activating its taskbar button could restore or focus the window without minimizing an active window.

## Decision

LunaUI's borderless top-level style includes `WS_SYSMENU | WS_MINIMIZEBOX` while remaining `WS_CAPTION`-free. The style is built by the shared Win32 helper and the lifecycle test asserts the taskbar-relevant bits and the captionless presentation. dsh-desktop continues to use the LunaUI style without an application-specific taskbar workaround.

## Alternatives considered

**Toggle on `WM_ACTIVATE`.** Activation is also used for ordinary focus changes, so toggling visibility there would minimize windows during normal application switching.

**Handle only the dsh-desktop window procedure.** This would leave the reusable LunaUI borderless window contract incorrect for other taskbar-visible consumers.

**Add a visible caption or custom taskbar proxy.** A caption changes the borderless presentation, while a proxy duplicates native taskbar behavior and ownership.

## Verification

The lifecycle regression test fails without `WS_MINIMIZEBOX` and passes with the corrected style. LunaUI Debug CTest passes 4/4, LunaUI Release example compilation passes, and the rebuilt dsh-desktop Release executable passes a Win32 probe that verifies `WS_MINIMIZEBOX`, no caption, and `SC_MINIMIZE` resulting in `IsIconic=True`.

## Consequences

Borderless top-level LunaUI windows retain their custom chrome while participating in the native taskbar minimize/restore behavior. The reusable style helper is now the source of truth for the taskbar-relevant window bits.
