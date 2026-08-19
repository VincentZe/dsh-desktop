# Agent Note: 从可见页面边缘启动原生缩放

Status: implemented

[English](2026-08-19-page-edge-resize-handles.md) | 中文

## Problem

原生 resize 命中测试使用透明窗口的最外层矩形，而 WebView 和用于显示阴影的可见圆角页面都向内缩了，所以 resize 光标和触发点落在可见页面边缘之外。页面 action 还会在目标是交互元素后停止，即使页面边缘本身已经预留给 resize。

## Decision

LunaUI 保留 WebView 内缩，同时提供 `native_resize_hit_test`，允许页面关闭透明外圈的原生命中测试。dsh-desktop 关闭这条路径，`DesktopChrome` 通过已有 `window` action 协议，从顶层可见外壳边缘委托 resize。边缘作为专用 resize 区域处理，因此无论下面渲染了哪个子元素，都以边缘几何为准。外壳及其后代元素会保持与边缘或角落方向对应的光标。非交互的指针跟随边框光效提示 hover 边缘，更强的内圈发光提示 resize 已按下；原生 `interaction-ended` 生命周期事件会在模态 resize 循环退出后清除 active 状态。

## Alternatives considered

**把原生命中测试向内移动。** 原生窗口不知道哪些可见页面元素是交互控件，继续移动原生层仍会让它和页面控件竞争命中。

**把 `resize_border` 设为零。** 这会移除圆角阴影需要的透明内缩，并把视觉呈现和 resize 策略耦合起来。

**安装八个透明页面覆盖层。** 独立覆盖层会在标题栏和控件上新增命中表面；根节点事件委托可以集中处理边缘几何而不增加覆盖元素。

## Verification

DesktopChrome 和样式聚焦套件共 10 个测试通过。`pnpm run build:web`、`pnpm run typecheck`、`cmake --build desktop/build --config Release --target dsh-desktop`、LunaUI Debug 库和测试、LunaUI runtime 测试，以及将 WebView2 SDK bin 目录加入 `PATH` 后的 CTest 均通过。

## Consequences

可见圆角页面边缘负责启动 resize，同时保留透明外圈用于绘制阴影。最大化窗口不会启动页面 resize。未来 LunaUI 使用者可以保留默认原生命中测试，或者在页面自己拥有边缘 action 时将 `native_resize_hit_test` 设为 `false`。
