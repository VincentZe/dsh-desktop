/**
 * Shared profile boot for every `dsh` surface: resolve the profile, stack its
 * patch layers (bundle layers in `dsh.profile.bundles` order, the profile's
 * own `cordis.patch.yml`, `--patch` overlays, the telemetry switch), mount the
 * tree over the profile's empty root config, keep the profile patch layer
 * live, and wire fail-loud plus bounded shutdown.
 *
 * App flags are not the launcher's business: the invocation's inner arguments
 * are provided to the tree through `ctx.cmdlineArgs`, where any injected app
 * plugin may read the same immutable snapshot.
 * @module @deepseek-ai/dsh/profile-boot
 */

import { writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FiberState, type Context } from '@deepseek-ai/cordis'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import {
  boot,
  composeEntries,
  healProfilesModuleFallback,
  installFailLoud,
  loadOptionalPatches,
  loadOverlayPatches,
  loadProfile,
  PROFILE_PATCH_FILENAME,
  watchUserPatches,
  type Profile,
} from '@deepseek-ai/dsh-app-boot'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'

/** Shipped agent-preset root: beside this app's own config, in both source and built layouts. */
const SHIPPED_PRESET_ROOT = fileURLToPath(new URL('../config/agent-presets/', import.meta.url))

import { DSH_LAUNCH_ENVIRONMENT_KEY, type LaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import { provideCmdline } from '@deepseek-ai/dsh-cmdline'
import { createProcessShutdown, type ProcessShutdown } from './process-shutdown.ts'

const NAME = 'dsh'
const require = createRequire(import.meta.url)

/** Bundle layers compiled into the fixed Web executable, in application order. */
const FIXED_WEB_BUNDLES = [
  '@deepseek-ai/dsh-base/cordis.patch.yml',
  '@deepseek-ai/dsh-web-app/cordis.patch.yml',
] as const

/**
 * The home-level user patch layer (`$DSH_HOME/cordis.patch.yml`), applied
 * over every profile's own layer. Resolved per call, not at module load:
 * `$DSH_HOME` may be set by the test or launcher after import.
 * @returns the absolute patch-file path.
 */
export function homePatchPath(): string {
  return join(resolveDshHome(), PROFILE_PATCH_FILENAME)
}

/** Absolute path of this dsh installation's package.json (both anchors: src/ and lib/ sit one level under apps/cli). */
export const INSTALL_ANCHOR = fileURLToPath(new URL('../package.json', import.meta.url))

/** The session-telemetry row id the DSH_TELEMETRY_DISABLED switch targets. */
const TELEMETRY_ROW_ID = 'session-telemetry-otel'

/** The empty root entry list every profile tree patches over. */
const PROFILE_ROOT_CONFIG = `# dsh profile root — an empty entry list. The tree is composed as patches:
# each bundle in package.json's dsh.profile.bundles, then cordis.patch.yml, then any
# --patch overlays. Edit cordis.patch.yml, not this file.
[]
`

/** Root config filename inside a profile directory. */
export const PROFILE_ROOT_FILENAME = 'cordis.yml'

/** Read-only empty root shipped beside the fixed Web runtime's package modules. */
const FIXED_WEB_ROOT_CONFIG = fileURLToPath(new URL('../config/fixed-web/cordis.yml', import.meta.url))

/**
 * Resolve the shipped Web patch files from the running dsh installation.
 * The fixed executable packages these files with its dependency closure, so
 * this list is independent of `$DSH_HOME` and cannot be extended at runtime.
 * @returns absolute patch paths in the fixed Web composition order.
 */
export function fixedWebPatchPaths(): readonly string[] {
  return FIXED_WEB_BUNDLES.map(specifier => require.resolve(specifier))
}

/**
 * Resolve the telemetry opt-out switch into its boot patch. ANY non-empty
 * value (including `'0'`/`'false'`) disables: a privacy switch prefers
 * off-by-mistake over on-by-mistake. A composition without the telemetry row
 * exports nothing, so the switch is then trivially satisfied and no patch is
 * generated — custom profiles need not mount telemetry to run with the
 * switch set.
 * @param disabledEnv - the raw `DSH_TELEMETRY_DISABLED` value (`undefined` when unset).
 * @param hasRow - whether the composition carries the telemetry row.
 * @returns the disable patch, or `undefined` when no hard-disable patch is required.
 */
export function resolveTelemetryPatch(disabledEnv: string | undefined, hasRow: boolean): PatchOptions | undefined {
  if ((disabledEnv ?? '') === '' || !hasRow) return undefined
  return { id: TELEMETRY_ROW_ID, disabled: true }
}

/**
 * Load a resolved profile for `name`: heal the shared module fallback, then
 * (re)write the empty root config. The root is always rewritten: the whole
 * composition is patch layers, and the vendored Loader's tree write-back (a
 * plugin self-disposing persists the current tree) can bake composed rows
 * into this file — which would duplicate every bundle insert on the next
 * boot. The file exists on disk only because the Loader needs a real include
 * root to anchor `baseUrl` at the profile directory (the config dump anchors
 * on the same file, so both compose over the identical base).
 * @param name - the profile name.
 * @param userLayer - `false` skips parsing `cordis.patch.yml` (the default dump).
 * @returns the loaded profile.
 */
export function prepareProfile(name: string, userLayer = true): Profile {
  healProfilesModuleFallback(INSTALL_ANCHOR)
  const profile = loadProfile(NAME, name, INSTALL_ANCHOR, undefined, { userLayer })
  writeFileSync(join(profile.dir, PROFILE_ROOT_FILENAME), PROFILE_ROOT_CONFIG)
  return profile
}

/** One profile's patch layers (application order) and the row index of its pre-flag composition. */
interface ComposedProfile {
  profile: Profile
  /** Bundle layers concatenated — the part below the user layers on a live reload. */
  bundlePatches: PatchOptions[]
  /** The home-level user layer (`$DSH_HOME/cordis.patch.yml`), applied after the profile's own. */
  homePatches: PatchOptions[]
  /** Layers above the user layers on a live reload: `--patch` overlays and the telemetry switch. */
  overlays: PatchOptions[]
}

/** The full patch stack of one composed profile, in application order. */
function allPatches(composed: ComposedProfile): PatchOptions[] {
  return [
    ...composed.bundlePatches,
    ...composed.profile.patches,
    ...composed.homePatches,
    ...composed.overlays,
  ]
}

/** Return launcher-owned rows that are fixed by the shipped CLI, not by a user profile. */
function launcherPatches(patches: PatchOptions[]): PatchOptions[] {
  const rows = new Map<string, EntryOptions>()
  for (const row of composeEntries([patches])) {
    if (typeof row.id === 'string') rows.set(row.id, row)
  }
  const result: PatchOptions[] = []
  const presetRow = rows.get('agent-presets')
  if (presetRow !== undefined) {
    result.push({
      id: 'agent-presets',
      config: {
        ...(presetRow.config ?? {}) as Record<string, unknown>,
        roots: [{ path: SHIPPED_PRESET_ROOT, trust: 'system' }],
      },
    })
  }
  const telemetryPatch = resolveTelemetryPatch(process.env.DSH_TELEMETRY_DISABLED, rows.has(TELEMETRY_ROW_ID))
  if (telemetryPatch !== undefined) result.push(telemetryPatch)
  return result
}

/** Add launcher-owned rows to a complete fixed composition. */
function appendLauncherPatches(patches: PatchOptions[]): PatchOptions[] {
  return [...patches, ...launcherPatches(patches)]
}

/**
 * Load `name` and compose its effective patch stack: bundle layers in
 * `dsh.profile.bundles` order (the base bundle gates the shell stacks by
 * platform on its own rows), the profile's user layer, the home-level user
 * layer (`$DSH_HOME/cordis.patch.yml` — machine-local preferences that apply
 * to every profile, so it outranks the per-profile layer), `--patch` overlays,
 * then the telemetry switch.
 * @param name - the profile name.
 * @param patchFiles - `--patch` overlay paths, in argv order.
 * @returns the profile, its patch layers, and the composed row index.
 */
function composeProfile(
  name: string,
  patchFiles: readonly string[],
): ComposedProfile {
  const profile = prepareProfile(name)
  const homePatches = loadOptionalPatches(NAME, homePatchPath()) ?? []
  const overlays = patchFiles.flatMap(file => loadOverlayPatches(NAME, resolve(file)))
  const bundlePatches = profile.layers.flatMap(layer => layer.patches)
  const launcher = launcherPatches([...bundlePatches, ...profile.patches, ...homePatches, ...overlays])
  return { profile, bundlePatches, homePatches, overlays: [...overlays, ...launcher] }
}

/** Options for {@link runProfile}. */
export interface RunProfileOptions {
  /** This run's frozen environment snapshot, provided before any entry mounts. */
  environment: LaunchEnvironmentSnapshot
  /** The profile name to boot. */
  profile: string
  /** `--patch` overlay paths, in argv order. */
  patchFiles: readonly string[]
  /** The invocation's inner arguments, handed to the tree through `ctx.cmdlineArgs`. */
  args: readonly string[]
}

/**
 * Re-throw a watcher-setup failure unless a shutdown already owns the tree:
 * a signal aborted this invocation, or an app requested exit (`ctx.appExit`
 * from a fast one-shot) and the root's disposal rejected the in-flight setup
 * await. Either way the failure describes a tree that is exiting as asked,
 * not a broken watch.
 * @param ctx - the booted root context.
 * @param signal - this invocation's signal-shutdown fact.
 * @param error - the setup failure.
 */
function suppressShutdownError(ctx: Context, signal: AbortSignal, error: unknown): void {
  if (signal.aborted) return
  if (ctx.fiber.state !== FiberState.ACTIVE || ctx.get('loader') === undefined) return
  throw error
}

/** A patch watcher that belongs to a mutable profile surface. */
interface LivePatchLayer {
  /** Absolute patch file watched by Cordis HMR. */
  filename: string
  /** Compose the complete patch list after this file changes. */
  compose: (patches: PatchOptions[]) => PatchOptions[]
}

/** Input shared by the dynamic profile and fixed Web boot paths. */
interface BootPlan {
  /** This run's immutable launch environment snapshot. */
  environment: LaunchEnvironmentSnapshot
  /** Absolute empty Include root. */
  rootConfig: string
  /** Complete initial patch list, already ordered by the caller. */
  patches: readonly PatchOptions[]
  /** Arguments owned by the mounted app plugins. */
  args: readonly string[]
  /** Optional installation anchor for bare plugin imports in a closed runtime. */
  bareModuleBaseUrl?: string
  /** Mutable patch layers to watch after the initial tree settles. */
  livePatchLayers?: readonly LivePatchLayer[]
}

/**
 * Boot one ordered patch composition and own its process lifetime.
 * @param plan - root, patches, launch facts, and optional mutable layers.
 * @returns the settled root context and its shutdown controller.
 */
async function runBootPlan(plan: BootPlan): Promise<{ ctx: Context; shutdown: ProcessShutdown }> {
  const app: { current?: Context } = {}
  const shutdown = createProcessShutdown(async () => { await app.current?.fiber.dispose() })
  const signalShutdown = new AbortController()
  const interrupt = (code: number): void => {
    signalShutdown.abort()
    shutdown.interrupt(code)
  }
  // Signals own teardown throughout the startup window, not only after boot()
  // settles: an inserted provider can publish before sibling rows finish mounting.
  // SIGTERM is a supervisor's ordinary stop request and exits 0 on every
  // surface — the launcher does not know whether the app considered its work
  // complete; SIGINT is a user interrupt and reports 130.
  process.on('SIGTERM', () => { interrupt(0) })
  process.on('SIGINT', () => { interrupt(130) })
  installFailLoud(NAME, process, async () => {
    await app.current?.fiber.dispose()
  })

  const livePatchLayers = plan.livePatchLayers ?? []
  // The dynamic profile path recomposes mutable patch files. The fixed Web
  // path has no layers here, so it cannot reload a new plugin after packaging.
  if (livePatchLayers.length === 0) {
    const ctx = await boot(NAME, plan.rootConfig, structuredClone([...plan.patches]), (hostCtx) => {
      app.current = hostCtx
      hostCtx.provide(DSH_LAUNCH_ENVIRONMENT_KEY, plan.environment)
      provideCmdline(hostCtx, {
        args: plan.args,
        exit: code => void shutdown.shutdown(code),
      })
    }, plan.bareModuleBaseUrl)
    app.current = ctx
    return { ctx, shutdown }
  }

  const ctx = await boot(NAME, plan.rootConfig, structuredClone([...plan.patches]), (hostCtx) => {
    app.current = hostCtx
    // Before any config-tree entry mounts, so plugins resolve all launch-time
    // environment values from the same immutable provenance snapshot.
    hostCtx.provide(DSH_LAUNCH_ENVIRONMENT_KEY, plan.environment)
    // The command line and bounded exit request are launcher facts available
    // to every app plugin that injects the argument snapshot.
    provideCmdline(hostCtx, {
      args: plan.args,
      exit: code => void shutdown.shutdown(code),
    })
  }, plan.bareModuleBaseUrl)
  app.current = ctx
  // A surface can dispose the whole tree while boot or this post-boot watcher
  // setup is still in flight — a signal, or a fast one-shot's appExit. Loader
  // presence and fiber state own liveness; the initial check skips a tree
  // that already exited, and the catch below re-checks for an exit that
  // landed mid-setup. Watching is unconditional: a one-shot surface exits
  // through its bounded shutdown, which disposes the watchers before the
  // loop drains.
  if (!signalShutdown.signal.aborted
    && ctx.fiber.state === FiberState.ACTIVE
    && ctx.get('loader') !== undefined) {
    try {
      // Config-only HMR for the live profile patch layer: the web bundle
      // disables the shared module-reload `hmr` row (its reload lifecycle is
      // untested), so when the composition leaves no HMR service, mount a
      // watch-only instance with no module roots — cordis.patch.yml edits stay
      // live on every long-lived surface. A silent skip would break the
      // documented hot-reload contract. HMR injects the timer service, which a
      // bare custom profile may not mount either.
      if (ctx.get('hmr') === undefined) {
        if (ctx.get('timer') === undefined) {
          await ctx.loader.create({ name: '@deepseek-ai/cordis-plugin-timer' })
        }
        await ctx.loader.create({ name: '@deepseek-ai/cordis-plugin-hmr', config: { root: [] } })
      }
      for (const layer of livePatchLayers) {
        await watchUserPatches(ctx, {
          binName: NAME,
          filename: layer.filename,
          compose: layer.compose,
        })
      }
    } catch (error) {
      suppressShutdownError(ctx, signalShutdown.signal, error)
    }
  }
  return { ctx, shutdown }
}

/**
 * Boot one profile invocation end to end and leave process lifetime to the
 * mounted plugins (or to a one-shot runner the composition mounts).
 * @param options - environment snapshot, profile name, overlays, and the booted app's own arguments.
 * @returns the settled root context and the shutdown controller.
 */
export async function runProfile(options: RunProfileOptions): Promise<{ ctx: Context; shutdown: ProcessShutdown }> {
  const composed = composeProfile(options.profile, options.patchFiles)
  const rootConfig = join(composed.profile.dir, PROFILE_ROOT_FILENAME)
  // Recomposition for the live user layers: bundle layers below, overlays
  // above, so a user edit can never displace them. Parsed app arguments are
  // not in here at all — they live in app-provided services that survive a
  // recomposition. BOTH user files are re-read per generation. Fresh clones
  // prevent Include's in-place patch updates from mutating the bundle defaults.
  const composeLive = (): PatchOptions[] => structuredClone([
    ...composed.bundlePatches,
    ...loadOptionalPatches(NAME, composed.profile.patchPath) ?? [],
    ...loadOptionalPatches(NAME, homePatchPath()) ?? [],
    ...composed.overlays,
  ])
  return runBootPlan({
    environment: options.environment,
    rootConfig,
    patches: allPatches(composed),
    args: options.args,
    livePatchLayers: [
      { filename: composed.profile.patchPath, compose: composeLive },
      { filename: homePatchPath(), compose: composeLive },
    ],
  })
}

/** Options for the fixed Web executable entry. */
export interface FixedWebProfileOptions {
  /** This run's frozen environment snapshot. */
  environment: LaunchEnvironmentSnapshot
  /** Arguments for the Web startup service, such as `--port 0`. */
  args: readonly string[]
}

/**
 * Boot the packaged Web composition without any user-owned plugin layer.
 * Sessions, settings, credentials, and other durable data still use
 * `$DSH_HOME`; only the Cordis patch roster and plugin code are fixed in the
 * installed runtime and change when the executable is rebuilt.
 * @param options - launch environment and Web application arguments.
 * @returns the settled root context and its shutdown controller.
 */
export async function runFixedWebProfile(
  options: FixedWebProfileOptions,
): Promise<{ ctx: Context; shutdown: ProcessShutdown }> {
  const patches = appendLauncherPatches(fixedWebPatchPaths().flatMap(path => loadOverlayPatches(NAME, path)))
  return runBootPlan({
    environment: options.environment,
    rootConfig: FIXED_WEB_ROOT_CONFIG,
    patches,
    args: options.args,
    // The fixed runtime owns all bare plugin resolution. No profile directory
    // is consulted, and no package manager state is needed at runtime.
    bareModuleBaseUrl: import.meta.url,
  })
}
