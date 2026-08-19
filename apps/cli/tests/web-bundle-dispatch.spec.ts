import { describe, expect, it } from 'vitest'
import { WINDOWS_ACL_RUNNER_ARG } from '@deepseek-ai/dsh-sandbox-windows-acl'
import { runnerArgsFromWebBundleArgv } from '../src/web-bundle-dispatch.ts'

describe('fixed Web runner dispatch', () => {
  it('extracts runner arguments when the SEA executable owns argv[1]', () => {
    expect(runnerArgsFromWebBundleArgv([
      'dsh-web.exe', WINDOWS_ACL_RUNNER_ARG, '--workspace', 'D:\\repo', '--', 'pwsh', '-Command', 'git status',
    ])).toEqual(['--workspace', 'D:\\repo', '--', 'pwsh', '-Command', 'git status'])
  })

  it('extracts runner arguments when the source entry owns argv[1]', () => {
    expect(runnerArgsFromWebBundleArgv([
      'node', 'web-bundle.js', WINDOWS_ACL_RUNNER_ARG, '--workspace', 'D:\\repo', '--', 'pwsh', '-Command', 'git status',
    ])).toEqual(['--workspace', 'D:\\repo', '--', 'pwsh', '-Command', 'git status'])
  })

  it('leaves ordinary Web arguments alone', () => {
    expect(runnerArgsFromWebBundleArgv(['dsh-web.exe', '--port', '0'])).toBeUndefined()
  })
})
