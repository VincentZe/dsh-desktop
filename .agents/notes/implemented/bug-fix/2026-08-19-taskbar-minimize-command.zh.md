# Agent Note: 保留无边框窗口的任务栏最小化命令

Status: implemented

[English](2026-08-19-taskbar-minimize-command.md) | 中文

## Problem

无边框 dsh-desktop 窗口虽然显示在任务栏中，但没有声明原生最小化命令，因此激活任务栏按钮时可能只恢复或聚焦活动窗口，不能将活动窗口最小化。

## Decision

LunaUI 的无边框顶层窗口样式包含 `WS_SYSMENU | WS_MINIMIZEBOX`，同时继续不包含 `WS_CAPTION`。样式由共享 Win32 辅助函数构建，生命周期测试校验任务栏相关样式位和无标题栏外观。dsh-desktop 继续使用 LunaUI 样式，不增加应用专用的任务栏绕过逻辑。

## Alternatives considered

**在 `WM_ACTIVATE` 中切换窗口状态。** `WM_ACTIVATE` 也用于普通焦点切换，在这里切换可见性会让应用正常切换时意外最小化窗口。

**只在 dsh-desktop 窗口过程中处理。** 这样会让其他显示在任务栏中的 LunaUI 无边框窗口继续缺少正确的通用窗口契约。

**增加可见标题栏或自建任务栏代理。** 标题栏会改变无边框外观，代理则会重复原生任务栏的行为和所有权。

## Verification

移除 `WS_MINIMIZEBOX` 时生命周期回归测试失败，使用修正样式后通过。LunaUI Debug CTest 通过 4/4，LunaUI Release 示例编译通过，重新构建的 dsh-desktop Release 可执行文件通过 Win32 检查：包含 `WS_MINIMIZEBOX`、不含标题栏，并且发送 `SC_MINIMIZE` 后 `IsIconic=True`。

## Consequences

无边框 LunaUI 顶层窗口保留自定义 chrome，同时参与原生任务栏的最小化和恢复行为。共享样式辅助函数成为任务栏相关窗口样式位的唯一来源。
