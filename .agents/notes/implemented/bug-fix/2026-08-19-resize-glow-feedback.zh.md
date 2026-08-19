# Agent Note: 页面反馈跟随原生 resize 指针

状态：已实现

[English](2026-08-19-resize-glow-feedback.md) | 中文

## 问题

可见页面负责发起 resize，而 Windows 负责模态缩放循环。该循环期间 WebView 不再收到普通指针事件，因此 active resize 光晕会停留在初始位置。顶栏拖拽提示在存在拖拽容器时也会常驻显示，并且页面中的部分覆盖层可能绘制在光晕之上。

## 决策

LunaUI 在窗口处于 `WM_ENTERSIZEMOVE`/`WM_EXITSIZEMOVE` 生命周期期间，将宿主客户区鼠标坐标作为 `windowResizePointer` 消息透传给页面。`DesktopChrome` 使用当前设备像素比换算这些物理坐标，并更新普通页面 hover 使用的同一组指针变量。顶栏提示只在声明的拖拽容器被 hover 时显示。resize 反馈使用内边框发光，并使用跟随指针、尺寸为可见光晕五倍的径向遮罩；非交互反馈层位于业务内容之上。

## 验证

DesktopChrome 聚焦套件覆盖仅 hover 时显示拖拽提示、原生指针坐标换算和 resize 生命周期清理；LunaUI 生命周期测试覆盖原生指针消息序列化。`pnpm run typecheck`、`pnpm run build:web`、前端聚焦测试、`cmake --build build --config Debug --target luna_ui_lifecycle_test` 和 `ctest --test-dir build -C Debug -R luna_ui_lifecycle_test --output-on-failure` 均通过。

## 结果

原生 resize 期间光晕仍可见并跟随指针，且不增加页面命中层。反馈层使用 `pointer-events: none`，页面控件继续拥有指针事件；原生窗口按钮位于反馈层之上。
