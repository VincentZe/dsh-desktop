# Agent Note: 通过按住指针刷选可见会话

Status: implemented

[English](2026-08-19-session-selection-brush.md) | 中文

## Problem

多选时必须逐条点击 Session 行，连续选择一组会话需要频繁移动指针。

## Decision

选择模式持有一个临时的指针刷选状态。在可选 Session 行上按下鼠标左键会记录起始行和操作类型；首次划入其他行时，无修饰键会替换当前选择，按住 `Shift` 会并入选择，按住 `Ctrl` 会减去选择，后续经过的行继续采用同一操作。移动刷选产生的合成 click 会被抑制，普通点击仍保留原有的单行切换行为。

复选框、行菜单和其他行操作控件不会启动刷选。回收站行和空白占位行仍然不参与刷选，指针释放或取消时会清理临时状态。

## Alternatives considered

**使用延迟长按计时器。** 计时器会在手势生效前增加任意等待，使普通点击变得迟钝；按住鼠标左键本身已经足以区分刷选和点击。

**根据起始行和当前行执行范围选择。** 分组视图和平铺视图可以独立排序，也不共享一个连续记账；按指针实际划过的可见行选择，不会引入用户看不到的排序语义。

**切换每一条经过的行。** 切换会让结果依赖已有选择状态，并可能意外取消会话；显式区分替换、并集和减集后，手势结果更可预测。

## Verification

`packages/client/ui-workspace/tests/workspace-browser.client.spec.tsx` 覆盖替换、`Shift` 并集、`Ctrl` 减集、刷选结束后的 click 抑制以及普通单行切换。WorkspaceBrowser 聚焦套件通过 46 个测试，相关 Rows 和 tree 套件通过 50 个测试，`pnpm run typecheck` 已通过。

## Consequences

该行为同时适用于分组和单列表 Session 视图，但只作用于当前实际渲染且被指针划入的行。刷选仍处于选择模式内，因此普通 Session 拖拽排序的含义保持不变。需要小范围调整时，继续使用单行点击或复选框。
