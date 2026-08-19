#!/usr/bin/env node
/**
 * Fixed Web runtime entry for desktop and single-file distributions.
 * The executable owns the Cordis and plugin roster; arguments belong only to
 * the Web startup service (`--port`, `--host`, and related Web options).
 * @module @deepseek-ai/dsh/web-bundle
 */

import { loadLayeredEnv } from '@deepseek-ai/dsh-app-boot'
import { runFixedWebProfile } from './profile-boot.ts'
import { runnerArgsFromWebBundleArgv } from './web-bundle-dispatch.ts'

const runnerArgs = runnerArgsFromWebBundleArgv(process.argv)
if (runnerArgs !== undefined) {
  const { runWindowsAclRunner } = await import('@deepseek-ai/dsh-sandbox-windows-acl/runner')
  process.exitCode = await runWindowsAclRunner(runnerArgs)
} else {
  process.env.DSH_FIXED_WEB_RUNTIME = '1'
  await runFixedWebProfile({
    environment: loadLayeredEnv('dsh-web'),
    args: process.argv.slice(2),
  })
}
