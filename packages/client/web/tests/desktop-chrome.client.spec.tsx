// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { DesktopChrome } from '../src/DesktopChrome.tsx'

interface FakeBridge {
  addEventListener(type: 'message', listener: (event: MessageEvent<unknown>) => void): void
  removeEventListener(type: 'message', listener: (event: MessageEvent<unknown>) => void): void
  postMessage(message: unknown): void
  messages: unknown[]
  emit(data: unknown): void
}

function installBridge(): FakeBridge {
  const listeners = new Set<(event: MessageEvent<unknown>) => void>()
  const bridge: FakeBridge = {
    addEventListener(_type, listener) { listeners.add(listener) },
    removeEventListener(_type, listener) { listeners.delete(listener) },
    postMessage(message) { bridge.messages.push(message) },
    messages: [],
    emit(data) {
      for (const listener of listeners) listener(new MessageEvent('message', { data }))
    },
  }
  Object.defineProperty(window, 'chrome', {
    configurable: true,
    value: { webview: bridge },
  })
  return bridge
}

afterEach(() => {
  cleanup()
  Object.defineProperty(window, 'chrome', { configurable: true, value: undefined })
})

describe('DesktopChrome', () => {
  it('renders floating native controls and forwards their actions', () => {
    const bridge = installBridge()
    const view = render(<DesktopChrome><div data-testid="content" /></DesktopChrome>)

    expect(view.getByTestId('content')).toBeTruthy()
    expect(bridge.messages).toEqual([{ type: 'window', action: 'state' }])

    fireEvent.click(view.getByRole('button', { name: '最小化窗口' }))
    fireEvent.click(view.getByRole('button', { name: '最大化窗口' }))
    fireEvent.click(view.getByRole('button', { name: '关闭窗口' }))
    expect(bridge.messages.slice(1)).toEqual([
      { type: 'window', action: 'minimize' },
      { type: 'window', action: 'toggle-maximize' },
      { type: 'window', action: 'close' },
    ])
  })

  it('changes the maximize control label after a native state update', () => {
    const bridge = installBridge()
    const view = render(<DesktopChrome><div /></DesktopChrome>)

    act(() => { bridge.emit({ kind: 'host:window-state', maximized: true }) })

    expect(view.getByRole('button', { name: '还原窗口' })).toBeTruthy()
  })

  it('starts a native move only from declared drag containers', () => {
    const bridge = installBridge()
    const view = render(
      <DesktopChrome>
        <div data-testid="page-background">
          <button type="button">页面按钮</button>
        </div>
        <div data-dsh-window-drag="true" data-testid="declared-drag-region">
          <button type="button">区域按钮</button>
          <span data-testid="declared-drag-space">空白</span>
        </div>
      </DesktopChrome>,
    )

    fireEvent.pointerDown(view.getByTestId('declared-drag-region'), { button: 0 })
    fireEvent.pointerDown(view.getByTestId('page-background'), { button: 0 })
    fireEvent.pointerDown(view.getByRole('button', { name: '页面按钮' }), { button: 0 })
    fireEvent.pointerDown(view.getByRole('button', { name: '区域按钮' }), { button: 0 })
    fireEvent.pointerDown(view.getByTestId('declared-drag-space'), { button: 0 })
    fireEvent.pointerDown(view.getByRole('button', { name: '最小化窗口' }), { button: 0 })
    fireEvent.pointerDown(view.getByTestId('declared-drag-region'), { button: 2 })

    expect(bridge.messages.slice(1)).toEqual([
      { type: 'window', action: 'drag' },
      { type: 'window', action: 'drag' },
    ])
  })

  it('keeps interactive descendants of a drag container local', () => {
    const bridge = installBridge()
    const onOpen = vi.fn()
    const view = render(
      <DesktopChrome>
        <div data-dsh-window-drag="true">
          <div role="treeitem" onClick={onOpen}>会话</div>
          <input aria-label="搜索" />
          <div data-host-drag-ignore="true" data-testid="ignored-region">保留给页面</div>
        </div>
      </DesktopChrome>,
    )

    fireEvent.pointerDown(view.getByRole('treeitem'), { button: 0 })
    fireEvent.click(view.getByRole('treeitem'))
    fireEvent.pointerDown(view.getByRole('textbox', { name: '搜索' }), { button: 0 })
    fireEvent.pointerDown(view.getByTestId('ignored-region'), { button: 0 })

    expect(onOpen).toHaveBeenCalledOnce()
    expect(bridge.messages.slice(1)).toEqual([])
  })

  it('shows the drag affordance only over the draggable part of a declared container', () => {
    const bridge = installBridge()
    const view = render(
      <DesktopChrome>
        <div data-dsh-window-drag="true">
          <span data-testid="drag-space">空白</span>
          <button type="button">按钮</button>
        </div>
      </DesktopChrome>,
    )
    const shell = view.container.querySelector('[data-dsh-window-shell="true"]')
    if (!(shell instanceof HTMLElement)) throw new Error('window shell missing')

    fireEvent.pointerMove(view.getByTestId('drag-space'), { button: 0 })
    expect(shell.getAttribute('data-drag-hover')).toBe('true')
    fireEvent.pointerMove(view.getByRole('button', { name: '按钮' }), { button: 0 })
    expect(shell.getAttribute('data-drag-hover')).toBeNull()
    expect(bridge.messages.slice(1)).toEqual([])
  })

  it('starts resize from the top-level edge even when a child is underneath', () => {
    const bridge = installBridge()
    const view = render(
      <DesktopChrome>
        <button type="button" data-testid="edge-button">页面按钮</button>
      </DesktopChrome>,
    )
    const shell = view.container.querySelector('[data-dsh-window-shell="true"]')
    if (!(shell instanceof HTMLElement)) throw new Error('window shell missing')
    vi.spyOn(shell, 'getBoundingClientRect').mockReturnValue({
      left: 10, top: 20, right: 510, bottom: 420, width: 500, height: 400,
      x: 10, y: 20, toJSON: () => ({}),
    })

    fireEvent.pointerMove(shell, { button: 0, clientX: 12, clientY: 200 })
    expect(shell.getAttribute('data-resize-hover')).toBe('left')
    fireEvent.pointerDown(view.getByTestId('edge-button'), { button: 0, clientX: 12, clientY: 200 })
    expect(bridge.messages.slice(1)).toEqual([
      { type: 'window', action: 'resize', edge: 'left' },
    ])
    expect(shell.getAttribute('data-resize-active')).toBe('left')

    act(() => { bridge.emit({ type: 'windowLifecycle', state: 'interaction-ended' }) })
    expect(shell.getAttribute('data-resize-active')).toBeNull()
  })

  it('updates the resize glow from native pointer coordinates during active resize', () => {
    const bridge = installBridge()
    const view = render(<DesktopChrome><div /></DesktopChrome>)
    const shell = view.container.querySelector('[data-dsh-window-shell="true"]')
    if (!(shell instanceof HTMLElement)) throw new Error('window shell missing')
    vi.spyOn(shell, 'getBoundingClientRect').mockReturnValue({
      left: 8, top: 8, right: 508, bottom: 408, width: 500, height: 400,
      x: 8, y: 8, toJSON: () => ({}),
    })
    const originalDevicePixelRatio = window.devicePixelRatio
    Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 2 })
    try {
      act(() => {
        bridge.emit({ type: 'windowResizePointer', x: 44, y: 60 })
      })

      expect(shell.style.getPropertyValue('--dsh-resize-x')).toBe('14px')
      expect(shell.style.getPropertyValue('--dsh-resize-y')).toBe('22px')
    } finally {
      Object.defineProperty(window, 'devicePixelRatio', {
        configurable: true,
        value: originalDevicePixelRatio,
      })
    }
  })

  it('does not start page resize while maximized', () => {
    const bridge = installBridge()
    const view = render(<DesktopChrome><div /></DesktopChrome>)
    const shell = view.container.querySelector('[data-dsh-window-shell="true"]')
    if (!(shell instanceof HTMLElement)) throw new Error('window shell missing')
    vi.spyOn(shell, 'getBoundingClientRect').mockReturnValue({
      left: 0, top: 0, right: 500, bottom: 400, width: 500, height: 400,
      x: 0, y: 0, toJSON: () => ({}),
    })
    act(() => { bridge.emit({ kind: 'host:window-state', maximized: true }) })

    fireEvent.pointerDown(shell, { button: 0, clientX: 2, clientY: 200 })
    expect(bridge.messages.slice(1)).toEqual([])
  })
})
