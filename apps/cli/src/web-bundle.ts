#!/usr/bin/env node
/**
 * Fixed Web runtime entry for desktop and single-file distributions.
 * The executable owns the Cordis and plugin roster; arguments belong only to
 * the Web startup service (`--port`, `--host`, and related Web options).
 * @module @deepseek-ai/dsh/web-bundle
 */

import { loadLayeredEnv } from '@deepseek-ai/dsh-app-boot'
import { runFixedWebProfile } from './profile-boot.ts'

await runFixedWebProfile({
  environment: loadLayeredEnv('dsh-web'),
  args: process.argv.slice(2),
})
