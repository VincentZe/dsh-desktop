import { useEffect, useMemo, useRef, useState } from 'react'
import type { PointerEvent, ReactNode } from 'react'
import css from './DesktopChrome.module.css'

type WindowAction = 'drag' | 'resize' | 'minimize' | 'toggle-maximize' | 'close' | 'state'
type WindowResizeEdge = 'left' | 'right' | 'top' | 'bottom' | 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'

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

function readWindowLifecycle(value: unknown): string | undefined {
  let message = value
  if (typeof message === 'string') {
    try {
      message = JSON.parse(message) as unknown
    } catch {
      return undefined
    }
  }
  if (!isRecord(message) || message.type !== 'windowLifecycle') return undefined
  return typeof message.state === 'string' ? message.state : undefined
}

function readResizePointer(value: unknown): { x: number; y: number } | undefined {
  let message = value
  if (typeof message === 'string') {
    try {
      message = JSON.parse(message) as unknown
    } catch {
      return undefined
    }
  }
  if (!isRecord(message) || message.type !== 'windowResizePointer') return undefined
  return typeof message.x === 'number' && typeof message.y === 'number'
    ? { x: message.x, y: message.y }
    : undefined
}

function WindowGlyph(props: { kind: 'minimize' | 'maximize' | 'restore' | 'close' }) {
  return <span aria-hidden className={`${css.glyph} ${css[props.kind]}`} />
}

const WINDOW_DRAG_IGNORE_SELECTOR = [
  'a',
  'button',
  'input',
  'textarea',
  'select',
  'option',
  '[contenteditable="true"]',
  '[role="button"]',
  '[role="link"]',
  '[role="menuitem"]',
  '[role="option"]',
  '[role="tab"]',
  '[role="treeitem"]',
  '[data-host-drag-ignore="true"]',
].join(', ')

function isWindowDragTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false
  if (target.closest('[data-dsh-window-drag="true"]') === null) return false
  return target.closest(WINDOW_DRAG_IGNORE_SELECTOR) === null
}

function resizeEdgeAt(element: HTMLElement, clientX: number, clientY: number): WindowResizeEdge | undefined {
  const rect = element.getBoundingClientRect()
  if (rect.width <= 0 || rect.height <= 0) return undefined
  const size = 16
  const onLeft = clientX >= rect.left && clientX - rect.left <= size
  const onRight = clientX <= rect.right && rect.right - clientX <= size
  const onTop = clientY >= rect.top && clientY - rect.top <= size
  const onBottom = clientY <= rect.bottom && rect.bottom - clientY <= size
  if (onTop && onLeft) return 'top-left'
  if (onTop && onRight) return 'top-right'
  if (onBottom && onLeft) return 'bottom-left'
  if (onBottom && onRight) return 'bottom-right'
  if (onTop) return 'top'
  if (onBottom) return 'bottom'
  if (onLeft) return 'left'
  if (onRight) return 'right'
  return undefined
}

/**
 * Native window controls for the LunaUI host window. Browser previews keep the
 * normal app tree unchanged; WebView2 receives the window protocol while the
 * page content remains full-bleed. Native moves start only from descendant
 * containers that explicitly declare `data-dsh-window-drag`; interactive
 * descendants of those containers remain owned by the page. Resize is
 * delegated by the shell root from its edge geometry, so the edge remains a
 * dedicated native resize strip regardless of which child is underneath it.
 *
 * @param props - the child app tree.
 * @returns the native chrome wrapper or the unchanged child tree in a browser.
 */
export function DesktopChrome(props: { children: ReactNode }) {
  const bridge = useMemo(getWebViewBridge, [])
  const shellRef = useRef<HTMLDivElement>(null)
  const [maximized, setMaximized] = useState(false)
  const [dragHover, setDragHover] = useState(false)
  const [hoverResizeEdge, setHoverResizeEdge] = useState<WindowResizeEdge | undefined>()
  const [activeResizeEdge, setActiveResizeEdge] = useState<WindowResizeEdge | undefined>()

  useEffect(() => {
    if (bridge === undefined) return
    const onMessage = (event: MessageEvent<unknown>) => {
      const next = readMaximized(event.data)
      if (next !== undefined) {
        setMaximized(next)
        if (next) {
          setHoverResizeEdge(undefined)
          setActiveResizeEdge(undefined)
        }
      }
      if (readWindowLifecycle(event.data) === 'interaction-ended') setActiveResizeEdge(undefined)
      const pointer = readResizePointer(event.data)
      if (pointer !== undefined) {
        const shell = shellRef.current
        if (shell !== null) {
          const rect = shell.getBoundingClientRect()
          const scale = window.devicePixelRatio || 1
          shell.style.setProperty('--dsh-resize-x', `${pointer.x / scale - rect.left}px`)
          shell.style.setProperty('--dsh-resize-y', `${pointer.y / scale - rect.top}px`)
        }
      }
    }
    bridge.addEventListener('message', onMessage)
    bridge.postMessage({ type: 'window', action: 'state' })
    const clearResize = () => { setActiveResizeEdge(undefined) }
    window.addEventListener('blur', clearResize)
    window.addEventListener('pointerup', clearResize)
    window.addEventListener('pointercancel', clearResize)
    return () => {
      bridge.removeEventListener('message', onMessage)
      window.removeEventListener('blur', clearResize)
      window.removeEventListener('pointerup', clearResize)
      window.removeEventListener('pointercancel', clearResize)
    }
  }, [bridge])

  if (bridge === undefined) return <>{props.children}</>

  const send = (action: WindowAction, edge?: WindowResizeEdge) => {
    bridge.postMessage(edge === undefined ? { type: 'window', action } : { type: 'window', action, edge })
  }
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const edge = !maximized
      ? resizeEdgeAt(event.currentTarget, event.clientX, event.clientY)
      : undefined
    setHoverResizeEdge(edge)
    setDragHover(isWindowDragTarget(event.target))
    const rect = event.currentTarget.getBoundingClientRect()
    event.currentTarget.style.setProperty('--dsh-resize-x', `${event.clientX - rect.left}px`)
    event.currentTarget.style.setProperty('--dsh-resize-y', `${event.clientY - rect.top}px`)
  }
  const onPointerLeave = () => {
    setDragHover(false)
    setHoverResizeEdge(undefined)
  }
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    const edge = !maximized
      ? resizeEdgeAt(event.currentTarget, event.clientX, event.clientY)
      : undefined
    if (event.button === 0 && edge !== undefined) {
      event.preventDefault()
      setActiveResizeEdge(edge)
      send('resize', edge)
      return
    }
    if (event.button !== 0 || !isWindowDragTarget(event.target)) return
    event.preventDefault()
    send('drag')
  }

  return (
    <div
      ref={shellRef}
      className={css.window}
      data-dsh-window-shell="true"
      data-maximized={maximized || undefined}
      data-drag-hover={dragHover || undefined}
      data-resize-hover={hoverResizeEdge}
      data-resize-active={activeResizeEdge}
      onPointerMove={onPointerMove}
      onPointerLeave={onPointerLeave}
      onPointerDown={onPointerDown}
    >
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
