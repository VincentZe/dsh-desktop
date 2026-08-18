# Agent Note: 保持桌面窗口壳的原生几何

Status: implemented

[English](2026-08-17-desktop-window-chrome-geometry.md) | 中文

## 问题

无边框桌面窗口会在 WebView 中渲染 React 文档，并为原生 resize 命中测试保留内缩区域。不透明的文档背景会遮住圆角处的 DWM 像素，壳层包装没有为子内容提供稳定的 flex 布局，而且原生窗口最大化时仍保留还原状态的圆角。无标题栏页面还需要支持拖动窗口，同时不能让窗口控制按钮变成拖动目标。

## 决策

`DesktopChrome` 标记原生壳，使 `base.css` 仅在桌面宿主中将文档背景设为透明。包装层采用绝对定位的纵向 flex 布局，还原状态保留 8 像素内缩，让圆角裁剪和小范围阴影位于 WebView 视口内；最大化时将内缩恢复为 0，并同时移除圆角和阴影。壳层提供 `--dsh-window-utility-clearance`，让 Session Header 右侧 utility 避开悬浮的原生窗口控件。非交互页面目标收到主按钮 pointer down 时发送 LunaUI 的 `{ type: "window", action: "drag" }`；按钮、表单控件、链接、标签、summary、role button、树节点和显式忽略的宿主控件继续保持交互。原生 resize 内缩和命中测试仍由 LunaUI 负责。

## 考虑过的替代方案

**保留不透明文档并依赖内部 CSS 圆角。** 否决：文档仍会绘制整个 WebView 矩形，DWM 无法提供外部圆角像素。

**增加独立标题栏或自行实现 resize。** 否决：桌面组合没有标题栏，而 LunaUI 已经负责原生 resize 命中测试和窗口移动原语。

**修改原生 resize 边框以适配页面布局。** 否决：原生八像素内缩是现有 resize 约定；回归发生在 React 包装层的几何和呈现逻辑中。

## 后果

- 还原状态的窗口会显示原生圆角和 resize 区域；最大化窗口会填满矩形客户区，不会留下页面圆角造成的缺口。
- 还原状态的窗口使用小范围阴影，最大化窗口会和圆角裁剪一起移除阴影。
- 还原状态页面四周保留 8 像素透明外圈承载阴影；最大化时随内缩一起移除外圈。
- Session log utility 通过壳层提供的 clearance 变量与原生控件组保持 8 像素间距。
- 页面背景可以通过现有 LunaUI 窗口协议拖动窗口，同时常见交互元素不会启动移动。
- 浏览器预览继续使用原有文档背景；由于没有 WebView bridge，也不会显示原生控制按钮。

## 测试

`packages/client/web/tests/desktop-chrome.client.spec.tsx` 校验页面背景拖动和交互元素排除规则。`packages/client/web/tests/base-styles.client.spec.ts` 校验仅桌面壳启用的透明根规则。TypeScript、AppRoot/DesktopChrome/base-style Vitest 测试集、生产 web 构建和 Release `dsh-desktop` target 均通过。
