/**
 * Locating a Rust toolchain and building the vendored FastCtx runtime.
 *
 * The plugin's runtime is a native executable, so a source checkout needs one
 * explicit, reproducible build step. This module owns it: find `cargo` without
 * guessing, run the release build in the vendored tree, and report the exact
 * toolchain that produced the binary.
 *
 * @module dsh-ops/rust
 */

import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PACKAGE_ROOT, executableName } from './binary.js'

/** Environment variable that names the `cargo` executable to use. */
export const CARGO_ENV = 'DSH_OPS_CARGO'

/** The vendored FastCtx source tree, relative to the plugin package root. */
export const VENDOR_DIR = path.join(PACKAGE_ROOT, 'vendor', 'fastctx')

/** Error raised when no usable Rust toolchain is found. */
export class CargoNotFoundError extends Error {
  /**
   * @param {string} message - the failure summary.
   * @param {string[]} tried - every candidate considered.
   */
  constructor(message, tried) {
    super(message)
    this.name = 'CargoNotFoundError'
    this.tried = tried
  }
}

/**
 * One process run, with its output collected.
 * @param {string} command - the executable.
 * @param {string[]} args - its arguments.
 * @param {object} options - run inputs.
 * @param {string} [options.cwd] - working directory.
 * @param {NodeJS.ProcessEnv} [options.env] - environment.
 * @returns {{status: number|null, stdout: string, stderr: string}} the outcome.
 */
function run(command, args, { cwd, env }) {
  const result = spawnSync(command, args, { cwd, env, encoding: 'utf8', windowsHide: true })
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? result.error?.message ?? '',
  }
}

/**
 * Candidate `cargo` executables, most explicit first.
 * @param {object} [options] - discovery inputs.
 * @param {NodeJS.ProcessEnv} [options.env] - the environment to read.
 * @param {string} [options.platform] - `process.platform`.
 * @returns {{file: string, source: string}[]} the candidates.
 */
function cargoCandidates({ env = process.env, platform = process.platform } = {}) {
  const name = platform === 'win32' ? 'cargo.exe' : 'cargo'
  /** @type {{file: string, source: string}[]} */
  const candidates = []
  if (env[CARGO_ENV] !== undefined && env[CARGO_ENV].trim() !== '') {
    candidates.push({ file: path.resolve(env[CARGO_ENV]), source: CARGO_ENV })
  }
  const cargoHome = env.CARGO_HOME
  if (cargoHome !== undefined && cargoHome.trim() !== '') {
    candidates.push({ file: path.join(cargoHome, 'bin', name), source: 'CARGO_HOME' })
  }
  candidates.push({ file: path.join(os.homedir(), '.cargo', 'bin', name), source: 'user cargo home' })
  // A relocated toolchain (a shared development drive, a CI image) is reached
  // through DSH_OPS_RUST_HOME, which names the directory holding `.cargo`.
  const rustHome = env.DSH_OPS_RUST_HOME
  if (rustHome !== undefined && rustHome.trim() !== '') {
    candidates.push({ file: path.join(rustHome, '.cargo', 'bin', name), source: 'DSH_OPS_RUST_HOME' })
  }
  candidates.push({ file: name, source: 'PATH' })
  return candidates
}

/**
 * Find a working `cargo`.
 *
 * `DSH_OPS_CARGO` is authoritative: when it names something unusable the search
 * fails instead of silently building with a different toolchain.
 * @param {object} [options] - discovery inputs.
 * @param {NodeJS.ProcessEnv} [options.env] - the environment to read.
 * @param {string} [options.platform] - `process.platform`.
 * @returns {{file: string, source: string, version: string, env: NodeJS.ProcessEnv}} the toolchain.
 * @throws {CargoNotFoundError} when no usable `cargo` is found.
 */
export function findCargo({ env = process.env, platform = process.platform } = {}) {
  /** @type {string[]} */
  const tried = []
  for (const candidate of cargoCandidates({ env, platform })) {
    if (candidate.file !== 'cargo' && candidate.file !== 'cargo.exe' && !fs.existsSync(candidate.file)) {
      tried.push(`${candidate.source}: ${candidate.file} (missing)`)
      continue
    }
    const probe = run(candidate.file, ['--version'], { env })
    if (probe.status === 0) {
      return { ...candidate, version: probe.stdout.trim(), env }
    }
    tried.push(`${candidate.source}: ${candidate.file} (${probe.stderr.trim().split('\n')[0] || `exited ${probe.status}`})`)
    if (candidate.source === CARGO_ENV) {
      throw new CargoNotFoundError(`${CARGO_ENV} does not name a working cargo`, tried)
    }
  }
  throw new CargoNotFoundError(
    'no working Rust toolchain found; install Rust, or set DSH_OPS_CARGO to the cargo executable, '
    + 'or set CARGO_HOME to the toolchain home',
    tried,
  )
}

/**
 * Probe an existing release build of the vendored source.
 * @param {object} [options] - probe inputs.
 * @param {string} [options.sourceDir] - the vendored FastCtx tree.
 * @param {string} [options.platform] - `process.platform`.
 * @returns {{file: string, mtimeMs: number}|undefined} the binary, when it exists.
 */
export function builtBinary({ sourceDir = VENDOR_DIR, platform = process.platform } = {}) {
  const file = path.join(sourceDir, 'target', 'release', executableName(platform))
  try {
    const stat = fs.statSync(file)
    return stat.isFile() ? { file, mtimeMs: stat.mtimeMs } : undefined
  } catch {
    return undefined
  }
}

/**
 * Whether the vendored source is newer than an existing release build, so a
 * rebuild is required before that binary may be trusted.
 * @param {object} [options] - the comparison inputs.
 * @param {string} [options.sourceDir] - the vendored FastCtx tree.
 * @param {string} [options.platform] - `process.platform`.
 * @returns {{stale: boolean, newestSourceMs: number, builtMs: number}|undefined} the verdict, absent when there is no build.
 */
export function buildFreshness({ sourceDir = VENDOR_DIR, platform = process.platform } = {}) {
  const built = builtBinary({ sourceDir, platform })
  if (built === undefined) return undefined
  let newest = 0
  const roots = [path.join(sourceDir, 'src'), path.join(sourceDir, 'build.rs'), path.join(sourceDir, 'Cargo.toml')]
  for (const root of roots) {
    if (!fs.existsSync(root)) continue
    const stat = fs.statSync(root)
    if (stat.isFile()) {
      newest = Math.max(newest, stat.mtimeMs)
      continue
    }
    for (const entry of fs.readdirSync(root, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile()) continue
      newest = Math.max(newest, fs.statSync(path.join(entry.parentPath, entry.name)).mtimeMs)
    }
  }
  return { stale: newest > built.mtimeMs, newestSourceMs: newest, builtMs: built.mtimeMs }
}

/**
 * Run `cargo build --release` over the vendored FastCtx source, streaming its
 * output to the caller's terminal.
 * @param {object} [options] - build inputs.
 * @param {object} [options.cargo] - the toolchain from {@link findCargo}.
 * @param {string} [options.sourceDir] - the vendored FastCtx tree.
 * @param {string[]} [options.extraArgs] - additional cargo arguments.
 * @param {(line: string) => void} [options.onLine] - receives each output line.
 * @returns {Promise<{code: number, output: string}>} the exit code and everything cargo wrote.
 */
export function cargoBuild({ cargo, sourceDir = VENDOR_DIR, extraArgs = [], onLine } = {}) {
  const args = ['build', '--release', '--locked', ...extraArgs]
  return new Promise((resolve, reject) => {
    const child = spawn(cargo.file, args, {
      cwd: sourceDir,
      env: cargo.env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    const forward = (chunk) => {
      const text = chunk.toString('utf8')
      output += text
      if (onLine !== undefined) for (const line of text.split('\n')) if (line !== '') onLine(line)
    }
    child.stdout.on('data', forward)
    child.stderr.on('data', forward)
    child.once('error', reject)
    child.once('close', (code) => resolve({ code: code ?? 1, output }))
  })
}
