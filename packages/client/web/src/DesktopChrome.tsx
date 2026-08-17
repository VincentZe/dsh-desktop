import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import css from './DesktopChrome.module.css'

type WindowAction = 'drag' | 'minimize' | 'toggle-maximize' | 'close' | 'state'

interface WebViewBridge {
  addEventListener(type: 'message', listener: (event: MessageEvent<unknown>) => void): void
  removeEventListener(type: 'message', listener: (event: MessageEvent<unknown>) => void): void
  postMessage(message: unknown): void
}

interface WindowWithWebView extends Window {
  chrome?: { webview?: WebViewBridge }
}

function getWebViewBridge(): WebViewBridge | undefined {
  const bridge = (window as WindowWithWebView).chrome?.webview
  return bridge !== undefined && typeof bridge.postMessage === 'function' ? bridge : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function readMaximized(value: unknown): boolean | undefined {
  let message = value
  if (typeof message === 'string') {
    try {
      message = JSON.parse(message) as unknown
    } catch {
      return undefined
    }
  }
  if (!isRecord(message) || message.kind !== 'host:window-state') return undefined
  return typeof message.maximized === 'boolean' ? message.maximized : undefined
}

function WindowGlyph(props: { kind: 'minimize' | 'maximize' | 'restore' | 'close' }) {
  return <span aria-hidden className={`${css.glyph} ${css[props.kind]}`} />
}

/**
 * Native window controls for the LunaUI host window. Browser previews keep the
 * normal app tree unchanged; WebView2 receives the window protocol while the
 * page content remains full-bleed. Only the narrow top drag region begins a
 * native move; the page body remains available for normal interaction.
 *
 * @param props - the child app tree.
 * @returns the native chrome wrapper or the unchanged child tree in a browser.
 */
export function DesktopChrome(props: { children: ReactNode }) {
  const bridge = useMemo(getWebViewBridge, [])
  const [maximized, setMaximized] = useState(false)

  useEffect(() => {
    if (bridge === undefined) return
    const onMessage = (event: MessageEvent<unknown>) => {
      const next = readMaximized(event.data)
      if (next !== undefined) setMaximized(next)
    }
    bridge.addEventListener('message', onMessage)
    bridge.postMessage({ type: 'window', action: 'state' })
    return () => { bridge.removeEventListener('message', onMessage) }
  }, [bridge])

  if (bridge === undefined) return <>{props.children}</>

  const send = (action: WindowAction) => { bridge.postMessage({ type: 'window', action }) }

  return (
    <div
      className={css.window}
      data-dsh-window-shell="true"
      data-maximized={maximized || undefined}
    >
      <div
        className={css.dragRegion}
        data-testid="window-drag-region"
        aria-hidden="true"
        onPointerDown={(event) => {
          if (event.button !== 0) return
          event.preventDefault()
          send('drag')
        }}
      />
      <div className={css.controls} data-host-drag-ignore="true">
        <button
          type="button"
          className={`${css.control} ${css.minimize}`}
          aria-label="最小化窗口"
          title="最小化窗口"
          onClick={() => { send('minimize') }}
        >
          <WindowGlyph kind="minimize" />
        </button>
        <button
          type="button"
          className={`${css.control} ${css.maximize}`}
          aria-label={maximized ? '还原窗口' : '最大化窗口'}
          title={maximized ? '还原窗口' : '最大化窗口'}
          onClick={() => { send('toggle-maximize') }}
        >
          <WindowGlyph kind={maximized ? 'restore' : 'maximize'} />
        </button>
        <button
          type="button"
          className={`${css.control} ${css.close}`}
          aria-label="关闭窗口"
          title="关闭窗口"
          onClick={() => { send('close') }}
        >
          <WindowGlyph kind="close" />
        </button>
      </div>
      <main className={css.content}>{props.children}</main>
    </div>
  )
}
