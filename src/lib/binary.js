/**
 * Locating the FastCtx executable this plugin hosts.
 *
 * FastCtx is a Rust runtime; the plugin never bundles it. Resolution is an
 * ordered search from the most explicit, operator-owned answer to the least,
 * and every step records why it did or did not match, so a failure reports the
 * whole search instead of "not found".
 *
 * @module dsh-ops/binary
 */

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

/** Repository root (`lib/`'s parent), used for the vendored source build path. */
export const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** Environment variable that overrides the search with one explicit path. */
export const BINARY_ENV = 'DSH_OPS_FASTCTX_BIN'

/**
 * The upstream FastCtx platform packages and the executable each carries.
 *
 * This is the chain's last package step, not a default: this distribution's own
 * build (`@dsh-ops/fastctx-<platform>-<arch>`) is preferred, and an upstream
 * package the deployment does have is still honoured — installed by hand, by a
 * profile, or by an install from before these names stopped riding along as
 * `optionalDependencies`.
 */
export const PLATFORM_TARGETS = Object.freeze({
  'win32-x64': { package: '@fastctx/win32-x64', executable: 'fastctx.exe' },
  'win32-arm64': { package: '@fastctx/win32-arm64', executable: 'fastctx.exe' },
  'linux-x64': { package: '@fastctx/linux-x64', executable: 'fastctx' },
  'darwin-x64': { package: '@fastctx/darwin-x64', executable: 'fastctx' },
  'darwin-arm64': { package: '@fastctx/darwin-arm64', executable: 'fastctx' },
})

/**
 * The plugin's own FastCtx platform package for one platform/architecture pair.
 *
 * A frozen name constructor rather than a lookup table: the release build
 * publishes `@dsh-ops/fastctx-<platform>-<arch>` — this fork's trimmed runtime —
 * and imports this function to name what it produced, so the name has exactly
 * one definition. The package carries the executable at
 * `bin/<executableName(platform)>`, the same shape as `@fastctx/<platform>-<arch>`.
 * @param {string} [platform] - `process.platform`.
 * @param {string} [arch] - `process.arch`.
 * @returns {string} the package name.
 */
export const opsFastctxPackage = Object.freeze(
  (platform = process.platform, arch = process.arch) => `@dsh-ops/fastctx-${platform}-${arch}`,
)

/** Error raised when no FastCtx executable can be resolved, carrying the search log. */
export class BinaryNotFoundError extends Error {
  /**
   * @param {string} message - the failure summary.
   * @param {{file: string, source: string, detail: string}[]} tried - every candidate considered.
   */
  constructor(message, tried) {
    super(message)
    this.name = 'BinaryNotFoundError'
    this.tried = tried
  }

  /**
   * The search log as an indented, one-line-per-candidate report.
   * @returns {string} the report.
   */
  report() {
    return this.tried
      .map((candidate) => `  - ${candidate.source}: ${candidate.file} (${candidate.detail})`)
      .join('\n')
  }
}

/**
 * The package target for one platform/architecture pair.
 * @param {string} [platform] - `process.platform`.
 * @param {string} [arch] - `process.arch`.
 * @returns {{package: string, executable: string}|undefined} the target, or undefined when unsupported.
 */
export function platformTarget(platform = process.platform, arch = process.arch) {
  return PLATFORM_TARGETS[`${platform}-${arch}`]
}

/**
 * The executable's file name on a platform.
 * @param {string} [platform] - `process.platform`.
 * @returns {string} `fastctx.exe` on Windows, `fastctx` elsewhere.
 */
export function executableName(platform = process.platform) {
  return platform === 'win32' ? 'fastctx.exe' : 'fastctx'
}

/**
 * The DSH home directory this deployment uses.
 * @param {NodeJS.ProcessEnv} [env] - the environment to read.
 * @returns {string} the absolute DSH home.
 */
export function dshHome(env = process.env) {
  return env.DSH_HOME && env.DSH_HOME.trim() !== ''
    ? path.resolve(env.DSH_HOME)
    : path.join(os.homedir(), '.dsh')
}

/**
 * The managed runtime directory: where `dsh-ops provision` installs the copy
 * this plugin prefers. Keeping it under the DSH home means it survives npm
 * cache cleanup and package upgrades.
 * @param {object} [options] - resolution inputs.
 * @param {NodeJS.ProcessEnv} [options.env] - the environment to read.
 * @returns {string} the absolute directory.
 */
export function managedRuntimeDir({ env = process.env } = {}) {
  return path.join(dshHome(env), 'dsh-ops', 'bin')
}

/**
 * The managed executable path.
 * @param {object} [options] - resolution inputs.
 * @param {NodeJS.ProcessEnv} [options.env] - the environment to read.
 * @param {string} [options.platform] - `process.platform`.
 * @returns {string} the absolute path.
 */
export function managedBinaryFile({ env = process.env, platform = process.platform } = {}) {
  return path.join(managedRuntimeDir({ env }), executableName(platform))
}

/**
 * The in-repository release build produced by `cargo build --release` over the
 * vendored FastCtx source. Present only in a source checkout whose owner ran
 * the build.
 * @param {object} [options] - resolution inputs.
 * @param {string} [options.packageRoot] - the plugin package root.
 * @param {string} [options.platform] - `process.platform`.
 * @returns {string} the absolute path.
 */
export function repoBuildFile({ packageRoot = PACKAGE_ROOT, platform = process.platform } = {}) {
  return path.join(packageRoot, 'vendor', 'fastctx', 'target', 'release', executableName(platform))
}

/**
 * Resolve the upstream package for this platform to its executable.
 *
 * Looked up under `root` — the plugin package root in production, a temporary
 * tree in a test — exactly as {@link opsFastctxPackageBinary} is, so both steps
 * of the chain answer "is this package installed here" from one place. A
 * platform with no upstream target, a package that is not installed, and an
 * installed package without its executable are each reported, never raised.
 * @param {object} options - resolution inputs.
 * @param {string} [options.platform] - `process.platform`.
 * @param {string} [options.arch] - `process.arch`.
 * @param {string} [options.root] - the package root to resolve from.
 * @returns {{file: string}|{error: string}} the executable, or why it is unusable.
 */
export function platformPackageBinary({
  platform = process.platform,
  arch = process.arch,
  root = PACKAGE_ROOT,
} = {}) {
  const target = platformTarget(platform, arch)
  if (target === undefined) return { error: `no FastCtx platform package for ${platform}-${arch}` }
  return packageBinaryAt({ name: target.package, executable: target.executable, root })
}

/**
 * Whether a package root's manifest declares one dependency name.
 *
 * Read only to make a search miss say which kind of miss it is; a manifest that
 * is absent, unreadable, or not JSON answers `false`, which is the plain "not
 * installed".
 * @param {string} root - the package root.
 * @param {string} name - the package name.
 * @returns {boolean} whether the manifest names it in `dependencies` or `optionalDependencies`.
 */
function declaresPackage(root, name) {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
    return name in { ...manifest.optionalDependencies, ...manifest.dependencies }
  } catch {
    return false
  }
}

/**
 * Resolve one platform package installed below a package root to the executable
 * in its `bin/`.
 *
 * Resolution starts at `root` rather than at this module, so a caller can point
 * the search at another tree, and every way of missing says which one it was:
 * absent, declared but not installed, or installed without its executable.
 * Nothing here throws — this is one step of a search, not a decision.
 * @param {object} options - resolution inputs.
 * @param {string} options.name - the package name.
 * @param {string} options.executable - the file name the package carries in `bin/`.
 * @param {string} options.root - the package root to resolve from.
 * @returns {{file: string}|{error: string}} the executable, or why it is unusable.
 */
function packageBinaryAt({ name, executable, root }) {
  let manifest
  try {
    const require = createRequire(path.join(root, 'package.json'))
    manifest = require.resolve(`${name}/package.json`)
  } catch {
    return {
      error: declaresPackage(root, name)
        ? `${name} is declared but not installed`
        : `${name} is not installed`,
    }
  }
  const file = path.join(path.dirname(manifest), 'bin', executable)
  return fs.existsSync(file) ? { file } : { error: `${name} is installed without bin/${executable}` }
}

/**
 * Resolve this plugin's own FastCtx platform package.
 *
 * The rung sits directly below the vendored source build: the package is this
 * fork's own trimmed runtime, so it is preferred over the upstream
 * `@fastctx/<platform>-<arch>` prebuild. A platform the release never published
 * for, a package that is not installed, and an installed package without its
 * executable are each reported and searched past, never raised.
 * @param {object} [options] - resolution inputs.
 * @param {string} [options.platform] - `process.platform`.
 * @param {string} [options.arch] - `process.arch`.
 * @param {string} [options.packageRoot] - the plugin package root to resolve from.
 * @returns {{file: string}|{error: string}} the executable, or why it is unusable.
 */
export function opsFastctxPackageBinary({
  platform = process.platform,
  arch = process.arch,
  packageRoot = PACKAGE_ROOT,
} = {}) {
  return packageBinaryAt({
    name: opsFastctxPackage(platform, arch),
    executable: executableName(platform),
    root: packageRoot,
  })
}

/**
 * Find an executable on `PATH`.
 * @param {object} [options] - resolution inputs.
 * @param {NodeJS.ProcessEnv} [options.env] - the environment to read.
 * @param {string} [options.platform] - `process.platform`.
 * @returns {{file: string}|{error: string}} the executable, or why none was found.
 */
export function pathBinary({ env = process.env, platform = process.platform } = {}) {
  const rawPath = env.PATH ?? env.Path ?? ''
  if (rawPath.trim() === '') return { error: 'PATH is empty' }
  const suffixes = platform === 'win32'
    ? (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').map((entry) => entry.trim().toLowerCase()).filter(Boolean)
    : ['']
  const names = platform === 'win32'
    ? ['fastctx', ...suffixes.map((suffix) => `fastctx${suffix}`)]
    : ['fastctx']
  for (const entry of rawPath.split(path.delimiter)) {
    const directory = entry.trim().replace(/^"(.*)"$/, '$1')
    if (directory === '' || !path.isAbsolute(directory)) continue
    for (const name of names) {
      const file = path.join(directory, name)
      if (fs.existsSync(file)) return { file }
    }
  }
  return { error: 'fastctx is not on PATH' }
}

/**
 * Describe one candidate path without executing it.
 * @param {string} file - the candidate.
 * @returns {string} a short reason why it is or is not usable.
 */
function describeFile(file) {
  try {
    const stat = fs.statSync(file)
    return stat.isFile() ? 'exists' : 'not a regular file'
  } catch (error) {
    return /** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT' ? 'missing' : String(error?.message ?? error)
  }
}

/**
 * Resolve the FastCtx executable to host.
 *
 * Order: explicit config, explicit environment, the managed copy installed by
 * `dsh-ops provision`, the in-repository release build, this plugin's own
 * FastCtx platform package (`@dsh-ops/fastctx-<platform>-<arch>`, the trimmed
 * fork), the upstream `@fastctx/<platform>-<arch>` prebuild, then `PATH`. An
 * explicitly configured path is authoritative: when it is unusable the search
 * fails instead of quietly hosting a different binary.
 *
 * @param {object} [options] - resolution inputs.
 * @param {string} [options.binaryPath] - the configured path, when one was given.
 * @param {string} [options.packageRoot] - the plugin package root.
 * @param {NodeJS.ProcessEnv} [options.env] - the environment to read.
 * @param {string} [options.platform] - `process.platform`.
 * @param {string} [options.arch] - `process.arch`.
 * @returns {{file: string, source: string, tried: {file: string, source: string, detail: string}[]}} the resolved executable.
 * @throws {BinaryNotFoundError} when nothing usable was found.
 */
export function resolveBinary({
  binaryPath,
  packageRoot = PACKAGE_ROOT,
  env = process.env,
  platform = process.platform,
  arch = process.arch,
} = {}) {
  /** @type {{file: string, source: string, detail: string}[]} */
  const tried = []

  if (binaryPath !== undefined) {
    const detail = describeFile(binaryPath)
    tried.push({ file: binaryPath, source: 'config.binaryPath', detail })
    if (detail !== 'exists') {
      throw new BinaryNotFoundError(
        `dsh-ops config.binaryPath does not name an existing file: ${binaryPath}`,
        tried,
      )
    }
    return { file: binaryPath, source: 'config.binaryPath', tried }
  }

  const fromEnv = env[BINARY_ENV]
  if (fromEnv !== undefined && fromEnv.trim() !== '') {
    const file = path.resolve(fromEnv)
    const detail = describeFile(file)
    tried.push({ file, source: `${BINARY_ENV}`, detail })
    if (detail !== 'exists') {
      throw new BinaryNotFoundError(`${BINARY_ENV} does not name an existing file: ${file}`, tried)
    }
    return { file, source: BINARY_ENV, tried }
  }

  const managed = managedBinaryFile({ env, platform })
  const managedDetail = describeFile(managed)
  tried.push({ file: managed, source: 'managed runtime', detail: managedDetail })
  if (managedDetail === 'exists') return { file: managed, source: 'managed runtime', tried }

  const built = repoBuildFile({ packageRoot, platform })
  const builtDetail = describeFile(built)
  tried.push({ file: built, source: 'vendored source build', detail: builtDetail })
  if (builtDetail === 'exists') return { file: built, source: 'vendored source build', tried }

  const ownPackage = opsFastctxPackageBinary({ platform, arch, packageRoot })
  if ('file' in ownPackage) {
    tried.push({ file: ownPackage.file, source: 'bundled fastctx package', detail: 'exists' })
    return { file: ownPackage.file, source: 'bundled fastctx package', tried }
  }
  tried.push({
    file: opsFastctxPackage(platform, arch),
    source: 'bundled fastctx package',
    detail: ownPackage.error,
  })

  const published = platformPackageBinary({ platform, arch, root: packageRoot })
  if ('file' in published) {
    tried.push({ file: published.file, source: 'published platform package', detail: 'exists' })
    return { file: published.file, source: 'published platform package', tried }
  }
  tried.push({
    file: platformTarget(platform, arch)?.package ?? `@fastctx/${platform}-${arch}`,
    source: 'published platform package',
    detail: published.error,
  })

  const onPath = pathBinary({ env, platform })
  if ('file' in onPath) {
    tried.push({ file: onPath.file, source: 'PATH', detail: 'exists' })
    return { file: onPath.file, source: 'PATH', tried }
  }
  tried.push({ file: 'fastctx', source: 'PATH', detail: onPath.error })

  throw new BinaryNotFoundError(
    'no FastCtx executable found; run `dsh-ops provision` from a source checkout, install the '
    + 'matching @dsh-ops/fastctx or @fastctx platform package, or set config.binaryPath',
    tried,
  )
}

/**
 * Run `--version` against a candidate to prove it is a working FastCtx build
 * before the plugin spawns it as its own MCP stdio server (`lib/tools.js`).
 * @param {string} file - the executable.
 * @param {object} [options] - probe inputs.
 * @param {number} [options.timeoutMs] - how long to wait.
 * @param {NodeJS.ProcessEnv} [options.env] - the environment to run with.
 * @returns {{ok: true, version: string}|{ok: false, detail: string}} the probe result.
 */
export function probeBinary(file, { timeoutMs = 15_000, env = process.env } = {}) {
  const result = spawnSync(file, ['--version'], {
    encoding: 'utf8',
    timeout: timeoutMs,
    windowsHide: true,
    env,
  })
  if (result.error !== undefined && result.error !== null) {
    return { ok: false, detail: String(result.error.message ?? result.error) }
  }
  if (result.status !== 0) {
    const stderr = (result.stderr ?? '').trim().split('\n')[0] ?? ''
    return { ok: false, detail: `exited ${result.status}${stderr === '' ? '' : `: ${stderr}`}` }
  }
  return { ok: true, version: (result.stdout ?? '').trim().split('\n')[0] ?? '' }
}
