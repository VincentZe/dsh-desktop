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
})
