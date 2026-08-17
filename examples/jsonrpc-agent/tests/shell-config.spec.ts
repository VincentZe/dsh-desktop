import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import * as yaml from 'js-yaml'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import { evaluate } from '@deepseek-ai/cordis-plugin-loader'

interface Entry {
  id?: string
  name?: string
  disabled?: unknown
  config?: Record<string, unknown>
}

const configPath = fileURLToPath(new URL('../cordis.yml', import.meta.url))

function entries(): Entry[] {
  const parsed = yaml.load(readFileSync(configPath, 'utf8'), { schema: entryListSchema })
  if (!Array.isArray(parsed)) throw new TypeError('jsonrpc-agent cordis.yml must parse to an entry list')
  return parsed as Entry[]
}

function disabledOn(entry: Entry, platform: 'win32' | 'linux'): boolean {
  const value = entry.disabled
  if (value !== null && typeof value === 'object' && '__jsExpr' in value) {
    return Boolean(evaluate({ process: { platform } }, (value as { __jsExpr: string }).__jsExpr))
  }
  return value === true
}

describe('jsonrpc-agent shell composition', () => {
  it('selects the platform-native confined executor and tool', () => {
    const byId = new Map(entries().map(entry => [entry.id, entry]))
    for (const id of ['bash', 'pwsh', 'tool-bash', 'tool-pwsh']) {
      expect(byId.has(id), `row ${id}`).toBe(true)
    }

    for (const [id, win32Disabled] of [
      ['bash', true],
      ['tool-bash', true],
      ['pwsh', false],
      ['tool-pwsh', false],
    ] as const) {
      expect(disabledOn(byId.get(id)!, 'win32'), `${id} on win32`).toBe(win32Disabled)
      expect(disabledOn(byId.get(id)!, 'linux'), `${id} on linux`).toBe(!win32Disabled)
    }
  })

  it('leaves shell tool ownership to the explicitly gated tool rows', () => {
    const shellEnv = entries().find(entry => entry.id === 'shell-env')
    const agentSpine = entries().find(entry => entry.id === 'agent-spine')
    expect(shellEnv?.name).toBe('@deepseek-ai/dsh-shell-env')
    expect(agentSpine?.config?.toolBash).toBe(false)
  })
})
