# Agent Note: 将原生窗口拖拽容器声明在外壳下层

Status: implemented

[English](2026-08-19-declared-window-drag-containers.md) | 中文

## Problem

覆盖窗口顶部的透明绝对定位层可能拦截本应交给页面控件处理的指针事件，例如搜索、会话导航和标题栏操作。

## Decision

`DesktopChrome` 在窗口外壳监听事件，只有指针目标位于 `[data-dsh-window-drag="true"]` 内部时才启动原生窗口移动。按钮、链接、表单控件、常见交互 ARIA 角色、可编辑内容、树项以及 `[data-host-drag-ignore="true"]` 后代继续由页面处理。侧栏 logo 行和会话标题栏声明拖拽容器；对话列表和消息区不声明。当存在拖拽容器时，外壳会在窗口内侧顶部绘制细描边和向下渐隐的内发光，并且不参与事件命中。

## Alternatives considered

**保留顶部绝对定位覆盖层。** 它提供较大的命中区域，但会改变浏览器的命中目标，并可能拦截覆盖层下方的页面控件。

**让整个窗口可拖拽，再逐项排除。** 每个新交互面都必须记得补排除规则，并且可能抢走滚动或列表行手势。

**由各 UI 包分别绑定原生事件。** 这会重复 WebView2 协议知识，并使不同界面的生命周期行为不一致；外壳负责分发，UI 包只声明可用容器。

## Verification

DesktopChrome、侧栏和对话区聚焦套件共 27 个测试通过。`pnpm run typecheck`、`pnpm run build:lib:client`、`pnpm run build:web` 和 `git diff --check` 通过。

## Consequences

侧栏顶部行和会话标题栏中的空白区域可以移动原生窗口。相同的顶栏提示会在窗口内边缘提供细微描边和内发光。其中的页面控件保留正常指针行为；未来的可拖拽界面通过声明该数据属性加入，同时显式保留交互后代的页面所有权。
