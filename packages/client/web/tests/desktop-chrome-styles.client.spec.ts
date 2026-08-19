/**
 * Native desktop chrome style contract. The WebView2 viewport is larger than
 * the visible rounded surface, so the transparent outer ring must remain
 * available for the shell shadow and rounded corners.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const desktopChromeCss = readFileSync(fileURLToPath(new URL('../src/DesktopChrome.module.css', import.meta.url)), 'utf8')

describe('DesktopChrome styles', () => {
  it('reserves a transparent outer ring for the native window shadow', () => {
    expect(desktopChromeCss).toContain('inset: var(--dsh-window-inset);')
    expect(desktopChromeCss).toContain('--dsh-window-inset: 8px;')
    expect(desktopChromeCss).toContain('inset: 0;')
  })

  it('does not install a transparent top overlay for dragging', () => {
    expect(desktopChromeCss).not.toContain('.dragRegion')
    expect(desktopChromeCss).toContain('[data-dsh-window-drag="true"]')
  })

  it('draws a non-interactive fading inner top affordance', () => {
    expect(desktopChromeCss).toContain('.window::before')
    expect(desktopChromeCss).toContain('mask-image: linear-gradient(180deg')
    expect(desktopChromeCss).toContain('box-shadow:')
    expect(desktopChromeCss).toContain('pointer-events: none;')
    expect(desktopChromeCss).toContain('.window[data-drag-hover]::before')
  })

  it('draws pointer-following hover and active resize feedback without a hit-test overlay', () => {
    expect(desktopChromeCss).toContain('.window::after')
    expect(desktopChromeCss).toContain('[data-resize-hover]::after')
    expect(desktopChromeCss).toContain('[data-resize-active]::after')
    expect(desktopChromeCss).toContain('--dsh-resize-x')
    expect(desktopChromeCss).toContain('--dsh-resize-halo-fade-stop: 20%')
    expect(desktopChromeCss).toContain('--dsh-resize-mask-fade-start: 15%')
    expect(desktopChromeCss).toContain('--dsh-resize-mask-fade-end: 100%')
    expect(desktopChromeCss).toContain('--dsh-resize-mask-size: 320px')
    expect(desktopChromeCss).toContain('--dsh-resize-mask-size: 380px')
    expect(desktopChromeCss).toContain('transparent var(--dsh-resize-halo-fade-stop)')
    expect(desktopChromeCss).toContain('transparent var(--dsh-resize-mask-fade-start)')
    expect(desktopChromeCss).toContain('#000 var(--dsh-resize-mask-fade-end)')
    expect(desktopChromeCss).toContain('border: 1px solid transparent;')
    expect(desktopChromeCss).toContain('transparent 0%, transparent var(--dsh-resize-mask-fade-start), #000 var(--dsh-resize-mask-fade-end)) border-box')
    expect(desktopChromeCss).toContain('mask-composite: exclude, intersect, intersect;')
    expect(desktopChromeCss).toContain('z-index: 2000;')
    expect(desktopChromeCss).toContain('pointer-events: none;')
  })

  it('uses directional cursors for all resize edges', () => {
    expect(desktopChromeCss).toContain('data-resize-hover="left"] *')
    expect(desktopChromeCss).toContain('cursor: ew-resize;')
    expect(desktopChromeCss).toContain('cursor: ns-resize;')
    expect(desktopChromeCss).toContain('cursor: nwse-resize;')
    expect(desktopChromeCss).toContain('cursor: nesw-resize;')
  })

  it('keeps minimize and maximize glyphs high-contrast on hover and focus', () => {
    expect(desktopChromeCss).toContain('.control.minimize:hover,')
    expect(desktopChromeCss).toContain('.control.maximize:focus-visible {')
    expect(desktopChromeCss).toContain('color: #fff;')
  })
})
