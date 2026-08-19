#!/usr/bin/env node
/**
 * Stable SEA bootstrap for the desktop Web runtime.
 *
 * The bootstrap stays beside the runtime package so plugin and client changes
 * can be shipped by replacing `dsh-web-runtime` without rebuilding this file.
 * @module @deepseek-ai/dsh/web-bootstrap
 */

import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** Resolve the sidecar entry beside the running executable. */
function runtimeEntry(): string {
  return join(dirname(process.execPath), 'dsh-web-runtime', 'lib', 'web-bundle.js')
}

const entry = runtimeEntry()
if (!existsSync(entry)) {
  process.stderr.write(`dsh-web: runtime package is missing: ${entry}\n`)
  process.exitCode = 1
} else {
  await import(pathToFileURL(entry).href)
}
