import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { fixedWebPatchPaths } from '../src/profile-boot.ts'

describe('fixed Web profile', () => {
  it('resolves exactly the shipped base and Web bundle layers', () => {
    const paths = fixedWebPatchPaths()

    expect(paths).toHaveLength(2)
    expect(paths.map((path) => {
      const manifest = JSON.parse(readFileSync(join(dirname(path), 'package.json'), 'utf8')) as { name?: string }
      return manifest.name
    })).toEqual(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])
    expect(paths.every(path => existsSync(path))).toBe(true)
  })
})
