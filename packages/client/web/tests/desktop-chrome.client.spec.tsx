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

  it('starts a native move only from the top drag region', () => {
    const bridge = installBridge()
    const view = render(
      <DesktopChrome>
        <div data-testid="page-background">
          <button type="button">页面按钮</button>
        </div>
      </DesktopChrome>,
    )

    fireEvent.pointerDown(view.getByTestId('window-drag-region'), { button: 0 })
    fireEvent.pointerDown(view.getByTestId('page-background'), { button: 0 })
    fireEvent.pointerDown(view.getByRole('button', { name: '页面按钮' }), { button: 0 })
    fireEvent.pointerDown(view.getByRole('button', { name: '最小化窗口' }), { button: 0 })
    fireEvent.pointerDown(view.getByTestId('window-drag-region'), { button: 2 })

    expect(bridge.messages.slice(1)).toEqual([{ type: 'window', action: 'drag' }])
  })

  it('keeps tree item clicks local instead of starting a native move', () => {
    const bridge = installBridge()
    const onOpen = vi.fn()
    const view = render(
      <DesktopChrome>
        <div role="treeitem" onClick={onOpen}>会话</div>
      </DesktopChrome>,
    )

    fireEvent.pointerDown(view.getByRole('treeitem'), { button: 0 })
    fireEvent.click(view.getByRole('treeitem'))

    expect(onOpen).toHaveBeenCalledOnce()
    expect(bridge.messages.slice(1)).toEqual([])
  })
})
