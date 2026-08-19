/**
 * Build the fixed Web runtime used by the Windows desktop package.
 * The staged production dependency closure is materialized without pnpm
 * junctions. The executable is a small Node SEA bootstrap; the fixed Web
 * composition is copied beside it as `dsh-web-runtime`.
 */

import { spawn } from 'node:child_process'
import { existsSync, globSync, lstatSync } from 'node:fs'
import { cp, lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { dirname, extname, join, relative, resolve, sep } from 'node:path'
import { parseArgs } from 'node:util'

const desktopRoot = resolve(import.meta.dirname)
const repoRoot = resolve(desktopRoot, '..')
const packageName = '@deepseek-ai/dsh'
const packageEntry = 'lib/web-bundle.js'
const bootstrapEntry = 'lib/web-bootstrap.js'
const pkgSpec = '@yao-pkg/pkg@6.21.0'

interface PackageManifest {
  name?: string
  dependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  peerDependenciesMeta?: Record<string, { optional?: boolean }>
  os?: string[]
  cpu?: string[]
}

interface DependencyReference {
  name: string
  optional: boolean
}

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    output: { type: 'string' },
    staging: { type: 'string' },
    runtime: { type: 'string' },
  },
})

const output = resolve(values.output ?? join(desktopRoot, 'build', 'portable', 'dsh', 'dsh-web.exe'))
const staging = resolve(values.staging ?? join(desktopRoot, 'build', '.dsh-web-staging'))
const runtimeOutput = resolve(values.runtime ?? join(dirname(output), 'dsh-web-runtime'))
const bootstrapStaging = `${staging}-bootstrap`
const deployWorkspace = join(dirname(repoRoot), '.dsh-web-deploy-work')

/** Packages whose manifests define the fixed Web composition and its launcher. */
const webRuntimeRoots = [
  '@deepseek-ai/dsh-base',
  '@deepseek-ai/dsh-web-app',
  '@deepseek-ai/dsh-app-boot',
  '@deepseek-ai/dsh-cmdline',
  '@deepseek-ai/dsh-home-paths',
  '@deepseek-ai/dsh-launch-environment',
  '@deepseek-ai/dsh-sandbox-windows-acl',
  '@deepseek-ai/cordis',
  '@deepseek-ai/cordis-plugin-group',
  '@deepseek-ai/cordis-plugin-include',
  '@deepseek-ai/cordis-plugin-loader',
  'node-addon-require-builtin',
] as const

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

/** Convert an import specifier to the package directory it resolves from. */
function packageNameFromSpecifier(specifier: string): string | undefined {
  if (specifier.startsWith('.') || specifier.startsWith('#') || specifier.startsWith('node:') || specifier.startsWith('file:')) return undefined
  const parts = specifier.split('/')
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
}

/** Resolve one deployed package using Node's upward `node_modules` lookup. */
function stagedPackagePath(packageName: string, fromDirectory: string): string | undefined {
  let directory = resolve(fromDirectory)
  const rootNodeModules = join(staging, 'node_modules')
  while (directory === staging || directory.startsWith(staging + sep)) {
    const candidate = join(directory, 'node_modules', ...packageName.split('/'))
    if (existsSync(join(candidate, 'package.json'))) return candidate
    if (directory === staging) break
    directory = dirname(directory)
  }
  const rootCandidate = join(rootNodeModules, ...packageName.split('/'))
  return existsSync(join(rootCandidate, 'package.json')) ? rootCandidate : undefined
}

/** Apply npm's positive/negative platform selector semantics to one field. */
function matchesPlatform(values: string[] | undefined, current: string): boolean {
  if (values === undefined || values.length === 0) return true
  const positives = values.filter(value => !value.startsWith('!'))
  return (positives.length === 0 || positives.includes(current)) && !values.includes(`!${current}`)
}

/** Whether a package manifest can run on the platform creating this package. */
function supportsCurrentPlatform(manifest: PackageManifest): boolean {
  return matchesPlatform(manifest.os, process.platform) && matchesPlatform(manifest.cpu, process.arch)
}

/** Preserve whether a missing dependency is an allowed platform omission. */
function dependencyReferences(manifest: PackageManifest): DependencyReference[] {
  const peerMeta = manifest.peerDependenciesMeta ?? {}
  return [
    ...Object.keys(manifest.dependencies ?? {}).map(name => ({ name, optional: false })),
    ...Object.keys(manifest.optionalDependencies ?? {}).map(name => ({ name, optional: true })),
    ...Object.keys(manifest.peerDependencies ?? {})
      .filter(name => peerMeta[name]?.optional !== true)
      .map(name => ({ name, optional: false })),
  ]
}

/** Built Web modules copied into the sidecar, excluding stale CLI chunks. */
const runtimeLibFiles = new Set<string>()

/** Add bare imports from the fixed Web entry and its relative chunks. */
async function addBuiltImports(required: Set<string>): Promise<void> {
  const queue = [join(staging, packageEntry)]
  const visited = new Set<string>()
  const importPattern = /(?:from\s*|import\s*\(|require\s*\()(['"])([^'"]+)\1/g
  while (queue.length > 0) {
    const file = queue.shift()
    if (file === undefined || visited.has(file)) continue
    visited.add(file)
    const relativeFile = relative(staging, file).split(sep).join('/')
    runtimeLibFiles.add(relativeFile)
    const source = await readFile(file, 'utf8')
    for (const match of source.matchAll(importPattern)) {
      const name = packageNameFromSpecifier(match[2])
      if (name !== undefined) {
        required.add(name)
        continue
      }
      if (!match[2].startsWith('.')) continue
      const importedFile = resolve(dirname(file), match[2])
      if (!importedFile.startsWith(join(staging, 'lib') + sep)) continue
      if (existsSync(importedFile)) queue.push(importedFile)
      else if (existsSync(`${importedFile}.js`)) queue.push(`${importedFile}.js`)
    }
  }
}

/** Traverse only the package closure owned by the fixed Web composition. */
async function pruneRuntimeDependencies(): Promise<void> {
  const requiredTopLevel = new Set<string>(webRuntimeRoots)
  await addBuiltImports(requiredTopLevel)
  const queue: Array<{ name: string, path: string }> = []
  for (const name of requiredTopLevel) {
    const path = stagedPackagePath(name, staging)
    if (path === undefined) throw new Error(`dsh-desktop: Web runtime dependency is missing: ${name}`)
    queue.push({ name, path })
  }
  const visited = new Set<string>()
  while (queue.length > 0) {
    const packageRef = queue.shift()
    if (packageRef === undefined || visited.has(packageRef.path)) continue
    visited.add(packageRef.path)
    const manifestPath = join(packageRef.path, 'package.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as PackageManifest
    if (!supportsCurrentPlatform(manifest)) {
      throw new Error(`dsh-desktop: Web runtime dependency is not supported on ${process.platform}/${process.arch}: ${packageRef.name}`)
    }
    for (const dependency of dependencyReferences(manifest)) {
      const dependencyPath = stagedPackagePath(dependency.name, packageRef.path)
      if (dependencyPath === undefined) {
        if (dependency.optional) continue
        throw new Error(`dsh-desktop: Web runtime dependency is missing: ${dependency.name}`)
      }
      const dependencyManifest = JSON.parse(await readFile(join(dependencyPath, 'package.json'), 'utf8')) as PackageManifest
      if (!supportsCurrentPlatform(dependencyManifest)) {
        if (dependency.optional) continue
        throw new Error(`dsh-desktop: Web runtime dependency is not supported on ${process.platform}/${process.arch}: ${dependency.name}`)
      }
      const topLevelPath = join(staging, 'node_modules', ...dependency.name.split('/'))
      if (resolve(dependencyPath) === resolve(topLevelPath)) requiredTopLevel.add(dependency.name)
      queue.push({ name: dependency.name, path: dependencyPath })
    }
  }

  const nodeModules = join(staging, 'node_modules')
  let removed = 0
  for (const entry of await readdir(nodeModules, { withFileTypes: true })) {
    if (entry.name === '.bin') continue
    if (entry.name.startsWith('@') && entry.isDirectory()) {
      const scope = join(nodeModules, entry.name)
      for (const child of await readdir(scope, { withFileTypes: true })) {
        const packageName = `${entry.name}/${child.name}`
        if (requiredTopLevel.has(packageName)) continue
        await rm(join(scope, child.name), { recursive: true, force: true })
        removed += 1
      }
      continue
    }
    if (!requiredTopLevel.has(entry.name)) {
      await rm(join(nodeModules, entry.name), { recursive: true, force: true })
      removed += 1
    }
  }
  await rm(join(nodeModules, '.pnpm'), { recursive: true, force: true })
  await rm(join(nodeModules, '.modules.yaml'), { force: true })
  console.log(`dsh-desktop: pruned Web runtime dependencies (${visited.size} kept, ${removed} top-level entries removed)`)
}

/** Keep only runtime files in the sidecar; source, tests, maps, and PDBs stay out. */
function keepRuntimePath(path: string): boolean {
  const relativePath = relative(staging, path).split(sep).join('/')
  const pathParts = relativePath.split('/')
  const fileName = pathParts[pathParts.length - 1] ?? ''
  const isDevelopmentPath = pathParts.some(part => ['.history', '__tests__', 'test', 'tests'].includes(part))
    || /(?:^|[._-])(test|spec)(?:[._-]|$)/i.test(fileName)
  if (isDevelopmentPath) return false
  if (relativePath === '' || lstatSync(path).isDirectory()) return true
  if (relativePath === 'package.json' || relativePath.startsWith('config/')) return true
  if (relativePath.startsWith('lib/')) return runtimeLibFiles.has(relativePath)
  if (!relativePath.startsWith('node_modules/')) return false
  if (relativePath.startsWith('node_modules/.bin/')) return false
  if (relativePath.endsWith('/package.json')) return true
  const extension = extname(relativePath).toLowerCase()
  return new Set([
    '.js', '.cjs', '.mjs', '.json', '.yml', '.yaml',
    '.html', '.css', '.svg', '.png', '.ico', '.woff', '.woff2', '.ttf',
    '.node', '.dll', '.wasm',
  ]).has(extension)
}

/** Copy the fixed Web package beside the bootstrap without development residue. */
async function copyRuntimeSidecar(): Promise<void> {
  await rm(runtimeOutput, { recursive: true, force: true })
  await mkdir(dirname(runtimeOutput), { recursive: true })
  await cp(staging, runtimeOutput, {
    recursive: true,
    dereference: true,
    filter: keepRuntimePath,
  })
}

/** Prepare the tiny package root consumed by the SEA bootstrap. */
async function prepareBootstrapStaging(): Promise<void> {
  await rm(bootstrapStaging, { recursive: true, force: true })
  await mkdir(join(bootstrapStaging, 'lib'), { recursive: true })
  const source = join(staging, bootstrapEntry)
  if (!existsSync(source)) {
    throw new Error(`dsh-desktop: ${source} is missing; build the CLI first`)
  }
  const sourceManifest = JSON.parse(await readFile(join(staging, 'package.json'), 'utf8')) as { version?: string }
  await writeFile(join(bootstrapStaging, 'package.json'), `${JSON.stringify({
    name: '@deepseek-ai/dsh-web-bootstrap',
    version: sourceManifest.version ?? '0.0.0',
    type: 'module',
    bin: bootstrapEntry,
    pkg: { assets: [bootstrapEntry] },
  }, null, 2)}\n`)
  await cp(source, join(bootstrapStaging, bootstrapEntry))
}

async function main(): Promise<void> {
  if (staging === repoRoot || repoRoot.startsWith(staging + sep)
    || runtimeOutput === repoRoot || repoRoot.startsWith(runtimeOutput + sep)) {
    throw new Error(`dsh-desktop: refusing to clear staging path ${staging}`)
  }
  await rm(staging, { recursive: true, force: true })
  await rm(bootstrapStaging, { recursive: true, force: true })
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
    await pruneRuntimeDependencies()
  } finally {
    await rm(deployWorkspace, { recursive: true, force: true })
  }
  await prepareBootstrapStaging()
  await mkdir(dirname(output), { recursive: true })
  await rm(output, { force: true })
  await run('package fixed Web executable', pnpmBin(), [
    'dlx', '--allow-build=esbuild', pkgSpec, bootstrapStaging,
    '--sea', '--compress', 'Zstd', '--targets', 'node24-win-x64', '--output', output,
  ], {}, dirname(repoRoot))
  if (!existsSync(output)) throw new Error(`dsh-desktop: packaged executable is missing: ${output}`)
  await copyRuntimeSidecar()
  const size = lstatSync(output).size / (1024 * 1024)
  await rm(staging, { recursive: true, force: true })
  await rm(bootstrapStaging, { recursive: true, force: true })
  console.log(`dsh-desktop: Web bootstrap ${output} (${size.toFixed(1)} MiB)`)
  console.log(`dsh-desktop: Web runtime sidecar ${runtimeOutput}`)
}

await main()
