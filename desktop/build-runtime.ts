/**
 * Build the fixed Web runtime used by the Windows desktop package.
 * The staged production dependency closure is materialized without pnpm
 * junctions, then packaged as one Node SEA executable whose entry is the
 * fixed `web-bundle` launcher.
 */

import { spawn } from 'node:child_process'
import { existsSync, globSync, lstatSync } from 'node:fs'
import { cp, lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { parseArgs } from 'node:util'

const desktopRoot = resolve(import.meta.dirname)
const repoRoot = resolve(desktopRoot, '..')
const packageName = '@deepseek-ai/dsh'
const packageEntry = 'lib/web-bundle.js'
const pkgSpec = '@yao-pkg/pkg@6.21.0'

interface PackageManifest {
  name?: string
  dependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  peerDependenciesMeta?: Record<string, { optional?: boolean }>
}

/** Runtime files that Cordis and the Web frontend resolve dynamically. */
const pkgAssets = [
  'config/**/*',
  'node_modules/**/*.js',
  'node_modules/**/*.cjs',
  'node_modules/**/*.mjs',
  'node_modules/**/package.json',
  'node_modules/**/*.json',
  'node_modules/**/*.yml',
  'node_modules/**/*.yaml',
  'node_modules/**/*.html',
  'node_modules/**/*.css',
  'node_modules/**/*.svg',
  'node_modules/**/*.png',
  'node_modules/**/*.ico',
  'node_modules/**/*.woff',
  'node_modules/**/*.woff2',
  'node_modules/**/*.ttf',
  'node_modules/**/*.node',
  'node_modules/**/*.dll',
  'node_modules/**/*.wasm',
]

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    output: { type: 'string' },
    staging: { type: 'string' },
  },
})

const output = resolve(values.output ?? join(desktopRoot, 'build', 'portable', 'dsh', 'dsh-web.exe'))
const staging = resolve(values.staging ?? join(desktopRoot, 'build', '.dsh-web-staging'))
const deployWorkspace = join(dirname(repoRoot), '.dsh-web-deploy-work')

function pnpmBin(): string {
  return process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
}

/** Keep the temporary deployment copy independent from every source install. */
function keepDeployWorkspacePath(path: string): boolean {
  if (path === repoRoot) return true
  if (!path.startsWith(repoRoot + sep)) return false
  const relative = path.slice(repoRoot.length + 1)
  const parts = relative.split(sep)
  return parts[0] !== 'desktop' && !parts.includes('node_modules') && !parts.includes('.git')
}

/** Copy the build inputs into a workspace whose install state can be discarded. */
async function createDeployWorkspace(): Promise<void> {
  await rm(deployWorkspace, { recursive: true, force: true })
  await mkdir(dirname(deployWorkspace), { recursive: true })
  await cp(repoRoot, deployWorkspace, {
    recursive: true,
    filter: keepDeployWorkspacePath,
  })
}

/** Exclude generated deployment residue from copied workspace packages. */
function keepWorkspacePath(path: string, source: string, nodeModules: string): boolean {
  const generatedDesktop = join(source, 'desktop')
  return path !== nodeModules
    && !path.startsWith(nodeModules + sep)
    && path !== generatedDesktop
    && !path.startsWith(generatedDesktop + sep)
}

/** Run one inherited-stdio subprocess. */
async function run(
  label: string,
  command: string,
  args: string[],
  environment: NodeJS.ProcessEnv = {},
  workingDirectory = repoRoot,
): Promise<void> {
  console.log(`dsh-desktop: ${label}: ${[command, ...args].join(' ')}`)
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: workingDirectory,
      stdio: 'inherit',
      shell: process.platform === 'win32',
      env: { ...process.env, CI: 'true', ...environment },
    })
    child.once('error', error => reject(new Error(`dsh-desktop: ${label} failed to spawn: ${error.message}`)))
    child.once('exit', (code, signal) => {
      if (code === 0) resolvePromise()
      else reject(new Error(`dsh-desktop: ${label} failed (${code === null ? `signal ${signal ?? 'unknown'}` : `exit ${code}`})`))
    })
  })
}

/** Find one symlink or Windows junction below a directory. */
async function findLink(directory: string): Promise<string | undefined> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    const metadata = await lstat(path)
    if (metadata.isSymbolicLink()) return path
    if (metadata.isDirectory()) {
      const nested = await findLink(path)
      if (nested !== undefined) return nested
    }
  }
  return undefined
}

/** Replace every deployed link with a private copy of its target. */
async function materializeLinks(): Promise<void> {
  const nodeModules = join(staging, 'node_modules')
  let link = await findLink(nodeModules)
  while (link !== undefined) {
    const source = await realpath(link)
    await rm(link, { recursive: true, force: true })
    const nestedNodeModules = join(source, 'node_modules')
    await cp(source, link, {
      recursive: true,
      dereference: true,
      filter: path => keepWorkspacePath(path, source, nestedNodeModules),
    })
    link = await findLink(nodeModules)
  }
}

/** Read the workspace package roots that legacy deploy may leave outside staging. */
async function loadWorkspacePackages(workspaceRoot: string): Promise<Map<string, string>> {
  const paths = globSync([
    'apps/*/package.json',
    'packages/*/*/package.json',
    'vendor/*/package.json',
  ], { cwd: workspaceRoot })
  const packages = new Map<string, string>()
  for (const relative of paths) {
    const directory = resolve(workspaceRoot, dirname(relative))
    const manifest = JSON.parse(await readFile(resolve(workspaceRoot, relative), 'utf8')) as PackageManifest
    if (manifest.name !== undefined) packages.set(manifest.name, directory)
  }
  return packages
}

/**
 * Restore workspace packages omitted by pnpm's legacy deploy implementation.
 * The staged manifest remains authoritative; only package directories present
 * in this repository are copied, and every restored package is traversed for
 * its own workspace dependencies.
 */
async function restoreWorkspaceDependencies(workspaceRoot: string): Promise<void> {
  const workspacePackages = await loadWorkspacePackages(workspaceRoot)
  const queue = [join(staging, 'package.json')]
  const visited = new Set<string>()
  while (queue.length > 0) {
    const manifestPath = queue.shift()
    if (manifestPath === undefined || visited.has(manifestPath)) continue
    visited.add(manifestPath)
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as PackageManifest
    const peerMeta = manifest.peerDependenciesMeta ?? {}
    const dependencies = new Set([
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.optionalDependencies ?? {}),
      ...Object.keys(manifest.peerDependencies ?? {}).filter(name => peerMeta[name]?.optional !== true),
    ])
    for (const dependency of dependencies) {
      const destination = join(staging, 'node_modules', dependency)
      if (!existsSync(destination)) {
        const source = workspacePackages.get(dependency)
        if (source === undefined) continue
        await mkdir(dirname(destination), { recursive: true })
        const nestedNodeModules = join(source, 'node_modules')
        await cp(source, destination, {
          recursive: true,
          dereference: true,
          filter: path => keepWorkspacePath(path, source, nestedNodeModules),
        })
      }
      const dependencyManifest = join(destination, 'package.json')
      if (existsSync(dependencyManifest)) queue.push(dependencyManifest)
    }
  }
}

/** Patch the deployed manifest for pkg's fixed executable and dynamic assets. */
async function injectPkgManifest(): Promise<void> {
  const manifestPath = join(staging, 'package.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>
  if (!existsSync(join(staging, packageEntry))) {
    throw new Error(`dsh-desktop: ${join(staging, packageEntry)} is missing; build the CLI first`)
  }
  await writeFile(manifestPath, `${JSON.stringify({
    ...manifest,
    bin: packageEntry,
    pkg: { assets: pkgAssets },
  }, null, 2)}\n`)
}

async function main(): Promise<void> {
  if (staging === repoRoot || repoRoot.startsWith(staging + sep)) {
    throw new Error(`dsh-desktop: refusing to clear staging path ${staging}`)
  }
  await rm(staging, { recursive: true, force: true })
  await mkdir(dirname(staging), { recursive: true })
  await createDeployWorkspace()
  try {
    await run('deploy fixed runtime', pnpmBin(), [
      '--ignore-scripts',
      '--filter', packageName,
      'deploy', '--legacy', '--prod',
      '--ignore-scripts',
      '--config.node-linker=hoisted',
      '--config.auto-install-peers=false',
      '--config.link-workspace-packages=true',
      '--config.confirmModulesPurge=false',
      staging,
    ], { npm_config_ignore_scripts: 'true' }, deployWorkspace)
    await restoreWorkspaceDependencies(deployWorkspace)
    await materializeLinks()
  } finally {
    await rm(deployWorkspace, { recursive: true, force: true })
  }
  await injectPkgManifest()
  await mkdir(dirname(output), { recursive: true })
  await rm(output, { force: true })
  await run('package fixed Web executable', pnpmBin(), [
    'dlx', '--allow-build=esbuild', pkgSpec, staging,
    '--sea', '--targets', 'node24-win-x64', '--output', output,
  ], {}, dirname(repoRoot))
  if (!existsSync(output)) throw new Error(`dsh-desktop: packaged executable is missing: ${output}`)
  const size = lstatSync(output).size / (1024 * 1024)
  console.log(`dsh-desktop: fixed Web executable ${output} (${size.toFixed(1)} MiB)`)
}

await main()
