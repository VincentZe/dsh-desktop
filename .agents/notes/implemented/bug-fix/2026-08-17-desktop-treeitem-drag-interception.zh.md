# Agent Note: 让可交互树节点避开原生窗口拖动

Status: implemented

[English](2026-08-17-desktop-treeitem-drag-interception.md) | 中文

## 问题

`DesktopChrome` 会对拖动忽略选择器之外的主按钮 pointer press 启动原生窗口移动。工作区和会话行使用带本地点击处理器的 `role="treeitem"` 元素，因此点击行也可能启动窗口移动，导致会话选择不稳定。

## 决策

`DesktopChrome` 将 `[role="treeitem"]` 与按钮、表单控件、链接及其他已忽略的宿主控件一起视为交互目标。页面背景继续作为原生移动目标，工作区和会话行点击留在 WebView 内并交给各自的本地处理器。

## 考虑过的替代方案

**让每个工作区和会话行停止事件传播。** 否决：这会把原生窗口协议的知识扩散到功能组件中，并让未来新增的交互行继续暴露同类缺陷。

**要求页面背景显式声明拖动区域属性。** 否决：这会改变现有的背景拖动行为，并要求标注整个壳，而不是扩展已有的交互目标规则。

## 后果

- 会话和工作区行可以选择或展开，不会发送原生 `window/drag` 消息。
- 非交互页面背景区域仍可用于原生窗口拖动。
- 新增的交互复合行如果不属于现有选择器范围，必须暴露可忽略的语义角色或 `data-host-drag-ignore="true"`。

## 测试

`packages/client/web/tests/desktop-chrome.client.spec.tsx` 验证树节点点击会调用本地处理器且不会发送原生拖动消息。DesktopChrome 窄测试通过 `4/4`，WorkspaceBrowser 测试通过 `40/40`，生产构建完成，重新打包的固定 Web 可执行文件返回 HTTP `200` 页面。
