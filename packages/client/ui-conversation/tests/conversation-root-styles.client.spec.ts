import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const stylesheet = readFileSync(
  fileURLToPath(new URL('../src/client/skeleton/ConversationRoot.module.css', import.meta.url)),
  'utf8',
)

describe('ConversationRoot styles', () => {
  it('keeps the conversation scrollbar inside the rounded window edges', () => {
    expect(stylesheet).toContain('.scrollBody {')
    expect(stylesheet).toContain('margin-block: 8px;')
  })

  it('declares a dedicated drag region for the blank conversation top edge', () => {
    expect(stylesheet).toContain('.topDragRegion {')
    expect(stylesheet).toContain('height: 56px;')
  })
})
