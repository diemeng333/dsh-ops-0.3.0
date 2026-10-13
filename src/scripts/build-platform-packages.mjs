#!/usr/bin/env node
/**
 * Build and verify the three platform packages this plugin publishes.
 *
 * All three packages carry ready-to-run Windows payloads. FastCtx is built from
 * vendored source; bash and pwsh are complete, digest-verified upstream runtime
 * trees with their licenses preserved. All are injected as exact optional deps.
 * Downloads happen during release assembly, never in an install lifecycle hook.
 *
 * `--verify-upstream` keeps the packages honest: it downloads the pinned assets,
 * checks each one against the sha256 recorded here, and deletes them again. It
 * never runs as part of `all`.
 *
 * NAMES AND PINS ARE NOT DEFINED HERE WHEN SOMETHING ELSE OWNS THEM. The scope
 * and the shell package names come from `lib/shells.js` (`PLATFORM_PACKAGES`);
 * the FastCtx package name comes from `lib/binary.js` (`opsFastctxPackage`, a
 * frozen name constructor). The shell pins are read from `lib/shells.js` too
 * when that module exports a pin table or a pin function (see
 * {@link resolveShellPin} for the shapes accepted); a module that exports
 * neither is an error, never a silent second copy of the pins in this file.
 * Re-scoping the release is therefore one edit in one module, and the pins have
 * exactly one definition per shell.
 *
 * PIPELINE. Each step is re-runnable on its own:
 *
 *   build         `cargo build --release --locked` over the vendored FastCtx
 *   assemble      the three package directories, from the committed skeletons
 *                 in `packages/<kind>-<platform>-<arch>/` plus the payload (for
 *                 fastctx) and a per-package `provenance.json` (for all three)
 *   pack          `npm pack` each directory, then write `SHA256SUMS` and the
 *                 release-wide `provenance.json`
 *   publish-dir   copy the main package into a temporary publish directory,
 *                 inject all three platform payload packages and pack it
 *   check         verify every artifact without downloading or building
 *   fetch         download the pinned upstream assets and keep them
 *   verify-upstream  download them, verify the digests, delete them again
 *
 * Everything lands under `--dist` (default: `../dist`, a sibling of this
 * checkout so a build never writes into the source tree).
 *
 * Usage:
 *   node scripts/build-platform-packages.mjs [command] [flags]
 *
 * Commands (default: `all`):
 *   all | build | assemble | pack | publish-dir | check | fetch | verify-upstream
 *
 * Flags:
 *   --platform <p>     target platform (default: win32 — the only one published)
 *   --arch <a>         target architecture (default: x64)
 *   --dist <path>      artifact directory (default: ../dist)
 *   --cargo <path>     cargo executable (default: $DSH_OPS_CARGO, then PATH)
 *   --proxy <url>      HTTP proxy for downloads (default: $HTTPS_PROXY/$HTTP_PROXY)
 *   --no-proxy         ignore the proxy environment
 *   --verify-upstream  alias for the `verify-upstream` command
 *   --force            re-download assets and rebuild stages
 *   --rebuild          run cargo even when a release binary already exists
 *   --check            alias for the `check` command
 *
 * @module dsh-ops/build-platform-packages
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import path from 'node:path'
import tls from 'node:tls'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import * as shellsModule from '../lib/shells.js'
import * as binaryModule from '../lib/binary.js'

/** This checkout's root: this script lives in `scripts/`. */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** The shell package prefixes, the only source of the release's names. */
const PLATFORM_PACKAGES = shellsModule.PLATFORM_PACKAGES

/**
 * The one derivation of every published name in this file.
 *
 * `PLATFORM_PACKAGES.bash.prefix` is the shell package prefix — the shared name
 * root followed by `bash-`. Removing that trailer leaves the root every package
 * of this release shares (`<scope>/` when the release is scoped, a bare
 * `dsh-ops-` when it is not), which is the only thing this file needs when
 * naming a package the code half does not name for it. There is deliberately no
 * scope literal anywhere below.
 */
const NAME_ROOT = PLATFORM_PACKAGES.bash.prefix.slice(0, PLATFORM_PACKAGES.bash.prefix.length - 'bash-'.length)

/** The payload package's kind; its name comes from `lib/binary.js`. */
const FASTCTX_KIND = 'fastctx'

/**
 * The digest of this script's own bytes.
 *
 * It is recorded in every `provenance.json` and checked before a previously
 * assembled stage is reused, so a stage is only ever reused while everything
 * that produced it — the payload or pin, the skeleton, and this pipeline — is
 * unchanged. A stale stage is the one failure mode a release pipeline must not
 * have: the digests it publishes would describe bytes nobody built.
 */
const SCRIPT_SHA256 = crypto.createHash('sha256')
  .update(fs.readFileSync(fileURLToPath(import.meta.url)))
  .digest('hex')

/**
 * The per-shell annotations this pipeline measured, which no pin table carries:
 * the copyright line, the executable's size, the launcher's PATH behaviour, and
 * the unpacked footprint of the upstream asset.
 *
 * PIN VALUES ARE NOT HERE. The upstream repository, release tag, version, asset
 * file, URL, digest, byte count, licence, extractor, and executable digest all
 * come from `lib/shells.js`'s `SHELL_UPSTREAM_PINS` (`shellUpstreamPin()` is the
 * lookup), so a version, a URL, or a digest is edited in one place and this file
 * holds no copy of any of them. What is left here is measurement:
 * `unpackedFiles`/`unpackedBytes` came from unpacking each asset and walking the
 * result twice — summing every file, then counting each inode once, which is
 * what `du --apparent-size` and npm's own `unpackedSize` report — `copyright` is
 * the upstream project's own line, and `entryNote` records what the executable
 * does and why the entry point is the file the plugin spawns.
 */
const SHELL_PIN_ANNOTATIONS = Object.freeze({
  bash: {
    copyright: 'Copyright (C) Linus Torvalds and others (the Git project); packaged for Windows by the Git for Windows project.',
    unpackedLayout: 'The archive root is the package root: bin/, cmd/, dev/, etc/, tmp/, ucrt64/, usr/, git-bash.exe, git-cmd.exe, LICENSE.txt, README.portable.',
    entryBytes: 45_416,
    entryNote: 'bin/bash.exe is upstream\'s launcher for usr/bin/bash.exe; it prepends the tree\'s own usr/bin and ucrt64/bin to PATH inside the shell it starts, which is how git, sed, and cygpath resolve inside the package.',
    // Measured by unpacking the asset and walking the result twice: once
    // summing every file's size, once counting each inode a single time (which
    // is what `du --apparent-size` and npm's own `unpackedSize` report).
    unpackedFiles: 9_611,
    unpackedBytes: 351_211_022,
    unpackedBytesSumOfFileSizes: 411_137_776,
    unpackedNote: 'Upstream\'s tree contains 84 hardlinked paths (a path and its twin share one inode), so summing '
      + 'every file\'s size gives 411,137,776 bytes while the tree occupies 351,211,022 bytes once each inode is '
      + 'counted once. Nothing here was linked, copied, or removed by this pipeline: both figures describe the '
      + 'archive as upstream published it.',
  },
  pwsh: {
    copyright: 'Copyright (c) Microsoft Corporation.',
    unpackedLayout: 'The archive root unpacks under bin/: bin/pwsh.exe, its DLLs, Modules/, and bin/LICENSE.txt.',
    entryBytes: 301_368,
    entryNote: 'bin/pwsh.exe is the shell the plugin\'s bundle patch points the host\'s pwsh-sandbox row at.',
    // Measured by unpacking the archive and walking the result: this tree has
    // no hardlinked paths, so both figures agree.
    unpackedFiles: 658,
    unpackedBytes: 256_625_143,
    unpackedBytesSumOfFileSizes: 256_625_143,
    unpackedNote: 'No two paths in this archive share an inode, so the sum of every file\'s size and the size of the '
      + 'tree are the same number.',
  },
})

/** The three packages one release publishes, in publish order. */
const KINDS = Object.freeze([FASTCTX_KIND, 'bash', 'pwsh'])

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

/**
 * Print one progress line.
 * @param {string} scope - the step or area the line belongs to.
 * @param {string} message - what happened.
 * @returns {void}
 */
function log(scope, message) {
  console.log(`[${scope}] ${message}`)
}

/** Print one warning line without failing the run. */
function warn(scope, message) {
  console.log(`[${scope}] WARNING ${message}`)
}

/**
 * Format a byte count for the reports a human reads: kibibytes while a pin
 * package is measured in kilobytes, mebibytes once it is not.
 * @param {number|undefined} bytes - the count.
 * @returns {string} the formatted size.
 */
function size(bytes) {
  if (bytes === undefined) return '?'
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`
}

/**
 * Read a JSON file, or return undefined when it is absent or unreadable.
 * @param {string} file - the path.
 * @returns {any} the parsed value, or undefined.
 */
function readJsonIfExists(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
}

/**
 * Write one JSON document with the repository's formatting (2 spaces, trailing newline).
 * @param {string} file - the path.
 * @param {unknown} value - the value to serialize.
 * @returns {void}
 */
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)
}

/**
 * The sha256 of one file, streamed so a large artifact is never held in memory twice.
 * @param {string} file - the path.
 * @returns {Promise<string>} the lowercase hex digest.
 */
async function sha256File(file) {
  const hash = crypto.createHash('sha256')
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

/**
 * Run one command and capture its output.
 * @param {string} command - the executable.
 * @param {string[]} args - its arguments.
 * @param {object} [options] - run options.
 * @param {string} [options.cwd] - the working directory.
 * @param {NodeJS.ProcessEnv} [options.env] - the environment.
 * @param {boolean} [options.inherit] - stream the child's output instead of capturing it.
 * @returns {{status: number, stdout: string, stderr: string}} the result.
 */
function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? REPO_ROOT,
    env: options.env ?? process.env,
    encoding: 'utf8',
    // `npm pack --json` describes every file it packed: the default 1 MiB
    // capture limit turns that report into ENOBUFS, so the cap is raised.
    maxBuffer: 512 * 1024 * 1024,
    stdio: options.inherit === true ? 'inherit' : 'pipe',
    windowsHide: true,
  })
  if (result.error !== undefined && result.error !== null) {
    throw new Error(`cannot run ${command}: ${String(result.error.message ?? result.error)}`)
  }
  const stdout = options.inherit === true ? '' : (result.stdout ?? '')
  const stderr = options.inherit === true ? '' : (result.stderr ?? '')
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed with exit code ${String(result.status)}`
      + (stderr.trim() === '' ? '' : `\n${stderr.trim()}`),
    )
  }
  return { status: result.status, stdout, stderr }
}

/**
 * How to run npm: through this Node's own npm CLI when it is next to the
 * interpreter, so no shell quoting is involved (spawning `npm.cmd` needs a
 * shell, which would make every path containing a space a parsing problem).
 * @param {string[]} args - the npm arguments.
 * @returns {{command: string, args: string[]}} the invocation.
 */
function npmInvocation(args) {
  const cli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
  return fs.existsSync(cli)
    ? { command: process.execPath, args: [cli, ...args] }
    : { command: 'npm', args }
}

/**
 * Run npm, capturing its output.
 * @param {string[]} args - the npm arguments.
 * @param {object} [options] - run options.
 * @returns {{status: number, stdout: string, stderr: string}} the result.
 */
function npm(args, options = {}) {
  const call = npmInvocation(args)
  return run(call.command, call.args, options)
}

/**
 * Parse the JSON document npm prints for `--json`, tolerating surrounding noise.
 * @param {string} stdout - the captured output.
 * @param {string} what - what was being parsed, for the error message.
 * @returns {any} the parsed value.
 */
function parseNpmJson(stdout, what) {
  const trimmed = stdout.trim()
  const candidates = [trimmed]
  const start = trimmed.indexOf('[')
  const end = trimmed.lastIndexOf(']')
  if (start >= 0 && end > start) candidates.push(trimmed.slice(start, end + 1))
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate)
    } catch {
      // try the next shape
    }
  }
  throw new Error(`cannot parse npm --json output for ${what}: ${trimmed.slice(0, 400)}`)
}

/** The main package's manifest, read once per run. */
function mainManifest() {
  return JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'))
}

/**
 * Copy one file or directory tree.
 * @param {string} source - the source path.
 * @param {string} destination - the destination path.
 * @returns {string[]} the package-relative paths written.
 */
function copyEntry(source, destination) {
  const written = []
  const stat = fs.statSync(source)
  if (stat.isDirectory()) {
    for (const entry of fs.readdirSync(source).sort()) {
      written.push(...copyEntry(path.join(source, entry), path.join(destination, entry)))
    }
    return written
  }
  fs.mkdirSync(path.dirname(destination), { recursive: true })
  fs.copyFileSync(source, destination)
  written.push(destination)
  return written
}

/**
 * Every file inside a directory tree, as package-relative paths.
 * @param {string} root - the directory.
 * @returns {string[]} the sorted relative paths, with `/` separators.
 */
function treeFiles(root) {
  const files = []
  /**
   * Walk one directory.
   * @param {string} current - the directory to walk.
   * @returns {void}
   */
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const file = path.join(current, entry.name)
      if (entry.isDirectory()) walk(file)
      else files.push(path.relative(root, file).replace(/\\/gu, '/'))
    }
  }
  walk(root)
  return files.sort()
}

/**
 * The current commit, for provenance, or `unknown` outside a git checkout.
 * @returns {string} the revision.
 */
function gitRevision() {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8', windowsHide: true })
  return result.status === 0 ? (result.stdout ?? '').trim() : 'unknown'
}

/**
 * The digest of one committed skeleton: every relative path and every file's
 * bytes, so a change to a notice or to the metadata forces the package to be
 * assembled again instead of silently reusing a stale stage.
 * @param {string} directory - the skeleton directory.
 * @returns {string} the lowercase hex digest.
 */
function skeletonDigest(directory) {
  const hash = crypto.createHash('sha256')
  /**
   * Fold one directory into the digest, in a stable order.
   * @param {string} current - the directory to walk.
   * @returns {void}
   */
  const walk = (current) => {
    const entries = fs.readdirSync(current, { withFileTypes: true })
      .sort((left, right) => (left.name < right.name ? -1 : 1))
    for (const entry of entries) {
      const file = path.join(current, entry.name)
      hash.update(`${path.relative(directory, file).replace(/\\/gu, '/')}\0`)
      if (entry.isDirectory()) walk(file)
      else hash.update(fs.readFileSync(file))
      hash.update('\0')
    }
  }
  walk(directory)
  return hash.digest('hex')
}

// ---------------------------------------------------------------------------
// Downloads (HTTP CONNECT through the local proxy when one is configured)
// ---------------------------------------------------------------------------

/**
 * The proxy to tunnel downloads through, when the environment names one.
 * @param {string|undefined} explicit - `--proxy`, when given.
 * @param {boolean} disabled - `--no-proxy`, when given.
 * @returns {{host: string, port: number, authorization?: string}|undefined} the proxy.
 */
function resolveProxy(explicit, disabled) {
  if (disabled) return undefined
  const raw = explicit ?? process.env.HTTPS_PROXY ?? process.env.https_proxy
    ?? process.env.HTTP_PROXY ?? process.env.http_proxy ?? ''
  if (raw.trim() === '') return undefined
  const url = new URL(raw)
  return {
    host: url.hostname,
    port: Number(url.port === '' ? 8080 : url.port),
    ...url.username === ''
      ? {}
      : { authorization: `Basic ${Buffer.from(`${url.username}:${url.password}`).toString('base64')}` },
  }
}

/**
 * Open one HTTP(S) response, following redirects, through the proxy when there is one.
 *
 * A configured proxy is used for every request: a direct connection that
 * happens to work would be a silent bypass of the proxy the environment
 * requires. HTTPS goes through a CONNECT tunnel whose socket is handed to
 * `http.request` (which does not add TLS of its own), so a redirect to another
 * host re-tunnels rather than reusing the first socket.
 *
 * @param {string} url - the URL to fetch.
 * @param {{host: string, port: number, authorization?: string}|undefined} proxy - the proxy.
 * @param {number} redirectsLeft - how many redirects remain.
 * @returns {Promise<{stream: NodeJS.ReadableStream, url: string}>} the response body.
 */
function openResponse(url, proxy, redirectsLeft) {
  return new Promise((resolve, reject) => {
    const target = new URL(url)
    const secure = target.protocol === 'https:'
    const port = Number(target.port === '' ? (secure ? 443 : 80) : target.port)
    const headers = {
      host: target.host,
      'user-agent': 'dsh-ops-release-script',
      accept: '*/*',
      'accept-encoding': 'identity',
    }
    /**
     * Handle one response: follow it, or resolve with the body.
     * @param {http.IncomingMessage} response - the response.
     * @returns {void}
     */
    const onResponse = (response) => {
      const code = response.statusCode ?? 0
      if ([301, 302, 303, 307, 308].includes(code)) {
        response.resume()
        if (redirectsLeft <= 0) {
          reject(new Error(`${url} redirected more than the allowed number of times`))
          return
        }
        const next = new URL(response.headers.location ?? '', url).toString()
        openResponse(next, proxy, redirectsLeft - 1).then(resolve, reject)
        return
      }
      if (code !== 200) {
        response.resume()
        reject(new Error(`${url} answered HTTP ${code}`))
        return
      }
      resolve({ stream: response, url })
    }

    /**
     * Send the plain GET over an already-secured (or plain) socket.
     * @param {import('node:net').Socket} socket - the tunnel socket.
     * @returns {void}
     */
    const send = (socket) => {
      const request = http.request(
        {
          host: target.hostname,
          port,
          method: 'GET',
          path: `${target.pathname}${target.search}`,
          headers,
          createConnection: () => socket,
        },
        onResponse,
      )
      request.on('error', reject)
      request.end()
    }

    if (proxy === undefined) {
      const request = (secure ? https : http).request(
        { host: target.hostname, port, method: 'GET', path: `${target.pathname}${target.search}`, headers },
        onResponse,
      )
      request.on('error', reject)
      request.end()
      return
    }

    const connect = http.request({
      host: proxy.host,
      port: proxy.port,
      method: 'CONNECT',
      path: `${target.hostname}:${port}`,
      headers: {
        host: `${target.hostname}:${port}`,
        ...proxy.authorization === undefined ? {} : { 'proxy-authorization': proxy.authorization },
      },
    })
    connect.on('error', (error) => reject(new Error(`proxy ${proxy.host}:${proxy.port} failed: ${String(error.message ?? error)}`)))
    connect.on('connect', (response, socket) => {
      if ((response.statusCode ?? 0) !== 200) {
        socket.destroy()
        reject(new Error(`proxy CONNECT ${target.hostname}:${port} answered HTTP ${String(response.statusCode)}`))
        return
      }
      if (!secure) {
        send(socket)
        return
      }
      const secured = tls.connect({ socket, servername: target.hostname })
      secured.once('secureConnect', () => send(secured))
      secured.once('error', (error) => reject(new Error(`TLS to ${target.hostname} failed: ${String(error.message ?? error)}`)))
    })
    connect.end()
  })
}

/**
 * Download one URL to a file, returning the byte count and digest.
 * @param {string} url - the URL.
 * @param {string} destination - where to write it.
 * @param {object} options - download options.
 * @param {{host: string, port: number, authorization?: string}|undefined} options.proxy - the proxy.
 * @param {number} options.expectedBytes - the size the upstream release reports.
 * @returns {Promise<{bytes: number, sha256: string}>} the facts about what arrived.
 */
async function download(url, destination, { proxy, expectedBytes }) {
  const partial = `${destination}.part`
  fs.mkdirSync(path.dirname(destination), { recursive: true })
  fs.rmSync(partial, { force: true })
  const { stream } = await openResponse(url, proxy, 5)
  const hash = crypto.createHash('sha256')
  let bytes = 0
  let reported = 0
  const output = fs.createWriteStream(partial)
  await new Promise((resolve, reject) => {
    stream.on('data', (chunk) => {
      hash.update(chunk)
      bytes += chunk.length
      if (bytes - reported >= 32 * 1024 * 1024) {
        reported = bytes
        log('fetch', `  ... ${size(bytes)}`)
      }
    })
    stream.on('error', reject)
    output.on('error', reject)
    output.on('finish', resolve)
    stream.pipe(output)
  })
  if (expectedBytes !== undefined && bytes !== expectedBytes) {
    fs.rmSync(partial, { force: true })
    throw new Error(`${url} delivered ${bytes} bytes, but the pin records ${expectedBytes}`)
  }
  fs.rmSync(destination, { force: true })
  fs.renameSync(partial, destination)
  return { bytes, sha256: hash.digest('hex') }
}

// ---------------------------------------------------------------------------
// Pins
// ---------------------------------------------------------------------------

/**
 * Read one field from a pin record, accepting the spellings a table of pins
 * might reasonably use for it.
 * @param {object} record - the pin record.
 * @param {string[]} names - the candidate keys.
 * @param {string|undefined} [nested] - a nested object key to look inside first.
 * @returns {any} the first value found.
 */
function field(record, names, nested) {
  const scopes = nested === undefined ? [record, record?.asset, record?.upstream, record?.payload] : [record?.[nested], record]
  for (const scope of scopes) {
    if (scope === null || typeof scope !== 'object') continue
    for (const name of names) {
      if (scope[name] !== undefined && scope[name] !== null) return scope[name]
    }
  }
  return undefined
}

/**
 * The pin record for one shell, from the module that owns the names.
 *
 * `lib/shells.js` is where a pin belongs: the package name and the payload the
 * package points at are one fact, and the code half owns both. This reads that
 * module defensively because its exact shape is the code half's to define —
 * accepting a `shellUpstreamPin({kind, platform, arch})`-style function or the
 * frozen `SHELL_UPSTREAM_PINS` list — and fails loudly when the module exports
 * a pin this pipeline cannot read. There is deliberately no fallback copy here:
 * a stale duplicate is exactly what one table per shell prevents, and `check`
 * prints the pin it used.
 *
 * @param {'bash'|'pwsh'} kind - which shell.
 * @param {string} platform - `process.platform`.
 * @param {string} arch - `process.arch`.
 * @returns {object} the normalized pin record.
 */
function resolveShellPin(kind, platform, arch) {
  const key = `${platform}-${arch}`
  const candidates = [
    [shellsModule.shellUpstreamPin, 'function'],
    [shellsModule.shellPin, 'function'],
    [shellsModule.opsShellPin, 'function'],
    [shellsModule.SHELL_UPSTREAM_PINS, 'list'],
    [shellsModule.SHELL_PINS, 'table'],
    [shellsModule.OPS_SHELL_PINS, 'table'],
    [shellsModule.SHELL_PAYLOAD_PINS, 'table'],
    [shellsModule.PLATFORM_SHELL_PINS, 'table'],
  ]
  for (const [candidate, form] of candidates) {
    if (candidate === undefined || candidate === null) continue
    let record
    if (form === 'function' && typeof candidate === 'function') {
      // `shellUpstreamPin` reads one options object; the positional shape is
      // still tried because the code half owns that signature.
      record = candidate({ kind, platform, arch }) ?? candidate(kind, platform, arch)
    } else if (form === 'list' && Array.isArray(candidate)) {
      record = candidate.find((entry) => (entry?.name ?? entry?.kind) === kind
        && (entry.platform ?? platform) === platform && (entry.arch ?? arch) === arch)
    } else if (form === 'table' && typeof candidate === 'object') {
      record = candidate[kind]?.[key] ?? candidate[kind]?.[platform]?.[arch] ?? candidate[key]?.[kind] ?? candidate[kind]
      if (record !== undefined && record.kind === undefined && record.package !== undefined) record = { ...record, kind }
    }
    const normalized = record === undefined || record === null ? undefined : normalizePin(record, kind)
    if (normalized !== undefined) return { ...normalized, pinSource: 'lib/shells.js' }
  }
  // No fallback: a pin this pipeline cannot read is a release it cannot
  // describe, and a second copy of the pins here is the drift the table in
  // `lib/shells.js` exists to prevent.
  throw new Error('lib/shells.js exports no shell pin for ' + kind + ' on ' + key
    + ': the release cannot describe an upstream artifact it cannot name.')
}

/**
 * Normalize one pin record into the shape this pipeline uses.
 *
 * A record is usable when it names an upstream location, an asset, and that
 * asset's digest: without those three a pin package would be metadata nobody
 * can act on, so a record missing any of them is treated as absent.
 * @param {object} record - the record, in whatever shape the source used.
 * @param {'bash'|'pwsh'} kind - which shell.
 * @returns {object|undefined} the normalized record, or undefined when unusable.
 */
function normalizePin(record, kind) {
  const assetUrl = field(record, ['assetUrl', 'url', 'downloadUrl', 'download', 'href'])
  const assetSha256 = field(record, ['assetSha256', 'sha256', 'digest', 'checksum'])
  const assetName = field(record, ['assetName', 'assetFile', 'file', 'fileName', 'asset'])
  if (typeof assetUrl !== 'string' || typeof assetSha256 !== 'string' || typeof assetName !== 'string') return undefined
  const measured = SHELL_PIN_ANNOTATIONS[kind] ?? {}
  return {
    kind,
    package: kind,
    upstream: field(record, ['upstream', 'upstreamRepo', 'repository', 'repo', 'homepage']) ?? measured.upstream,
    upstreamVersion: field(record, ['upstreamVersion', 'version', 'tag']) ?? measured.upstreamVersion,
    releaseTag: field(record, ['releaseTag', 'release', 'tag']) ?? measured.releaseTag,
    assetName,
    assetUrl,
    assetSha256,
    assetBytes: field(record, ['assetBytes', 'bytes', 'size']) ?? measured.assetBytes,
    license: field(record, ['license', 'licence', 'spdx']) ?? measured.license,
    copyright: field(record, ['copyright', 'attribution']) ?? measured.copyright,
    extractor: field(record, ['extractor', 'extractWith']) ?? measured.extractor,
    unpackedLayout: field(record, ['unpackedLayout', 'layout', 'unpacked']) ?? measured.unpackedLayout,
    entryPoint: field(record, ['entryPoint', 'executableRelativePath', 'executable', 'entry']) ?? measured.entryPoint,
    entrySha256: field(record, ['entrySha256', 'payloadSha256', 'executableSha256']) ?? measured.entrySha256,
    entryBytes: field(record, ['entryBytes', 'payloadBytes', 'executableBytes']) ?? measured.entryBytes,
    entryNote: field(record, ['entryNote', 'note']) ?? measured.entryNote,
    unpackedFiles: field(record, ['unpackedFiles', 'files']) ?? measured.unpackedFiles,
    unpackedBytes: field(record, ['unpackedBytes', 'unpackedSize']) ?? measured.unpackedBytes,
    unpackedBytesSumOfFileSizes: field(record, ['unpackedBytesSumOfFileSizes', 'unpackedSum'])
      ?? measured.unpackedBytesSumOfFileSizes,
    unpackedNote: field(record, ['unpackedNote']) ?? measured.unpackedNote,
  }
}

// ---------------------------------------------------------------------------
// What one release builds
// ---------------------------------------------------------------------------

/**
 * The published name of one shell package, from the module that owns the names.
 * @param {'bash'|'pwsh'} kind - which shell.
 * @param {string} platform - `process.platform`.
 * @param {string} arch - `process.arch`.
 * @returns {string} the package name.
 */
function shellPackageName(kind, platform, arch) {
  return `${PLATFORM_PACKAGES[kind].prefix}${platform}-${arch}`
}

/**
 * The published name of the FastCtx package, from the module that owns it.
 * @param {string} platform - `process.platform`.
 * @param {string} arch - `process.arch`.
 * @returns {string} the package name.
 */
function fastctxPackageName(platform, arch) {
  const owned = binaryModule.opsFastctxPackage
  if (typeof owned === 'function') {
    const value = owned(platform, arch)
    if (typeof value === 'string' && value !== '') return value
    if (value !== null && typeof value === 'object') {
      const name = value.package ?? value.name
      if (typeof name === 'string' && name !== '') return name
    }
    throw new Error(`lib/binary.js opsFastctxPackage(${platform}, ${arch}) returned ${JSON.stringify(value)}`)
  }
  warn('names', 'lib/binary.js does not export opsFastctxPackage yet; deriving the FastCtx package name from the shared root')
  return `${NAME_ROOT}${FASTCTX_KIND}-${platform}-${arch}`
}

/**
 * Describe every package this run builds.
 * @param {string} platform - `process.platform`.
 * @param {string} arch - `process.arch`.
 * @param {string} dist - the artifact directory.
 * @returns {object[]} one description per package, in publish order.
 */
function describePackages(platform, arch, dist) {
  const version = mainManifest().version
  return [
    {
      kind: FASTCTX_KIND,
      name: fastctxPackageName(platform, arch),
      version,
      platform,
      arch,
      dist,
      executable: `bin/${binaryModule.executableName(platform)}`,
      payload: {
        type: 'cargo',
        directory: path.join(REPO_ROOT, 'vendor', 'fastctx'),
        file: path.join(REPO_ROOT, 'vendor', 'fastctx', 'target', 'release', binaryModule.executableName(platform)),
      },
    },
    {
      kind: 'bash',
      name: shellPackageName('bash', platform, arch),
      version,
      platform,
      arch,
      dist,
      executable: `bin/${PLATFORM_PACKAGES.bash.executable}`,
      payload: { type: 'archive', pin: resolveShellPin('bash', platform, arch) },
    },
    {
      kind: 'pwsh',
      name: shellPackageName('pwsh', platform, arch),
      version,
      platform,
      arch,
      dist,
      executable: `bin/${PLATFORM_PACKAGES.pwsh.executable}`,
      payload: { type: 'archive', pin: resolveShellPin('pwsh', platform, arch) },
    },
  ]
}

/**
 * The committed skeleton directory of one package: the metadata and the
 * documents that belong in the package, kept in the repository rather than in
 * the build script. The directory is named `<kind>-<platform>-<arch>` and
 * carries no scope, so a re-scoped release renames nothing.
 * @param {object} pkg - the package description.
 * @returns {string} the absolute path.
 */
function skeletonDir(pkg) {
  return path.join(REPO_ROOT, 'packages', `${pkg.kind}-${pkg.platform}-${pkg.arch}`)
}

/** Where one package is assembled before packing. */
function stageDir(pkg) {
  return path.join(pkg.dist, 'stage', `${pkg.kind}-${pkg.platform}-${pkg.arch}`)
}

// ---------------------------------------------------------------------------
// Step: build (the vendored FastCtx release binary)
// ---------------------------------------------------------------------------

/**
 * Resolve the cargo executable and the rustup environment around it.
 * @param {string|undefined} explicit - `--cargo`, when given.
 * @param {object} context - the run context.
 * @returns {{command: string, env: NodeJS.ProcessEnv, version: string}} the invocation.
 */
function cargoInvocation(explicit, context) {
  const candidates = [
    explicit,
    process.env.DSH_OPS_CARGO,
    process.env.CARGO,
    'cargo',
    process.platform === 'win32'
      ? path.join(process.env.USERPROFILE ?? '', '.cargo', 'bin', 'cargo.exe')
      : path.join(process.env.HOME ?? '', '.cargo', 'bin', 'cargo'),
  ].filter((candidate) => typeof candidate === 'string' && candidate !== '')
  const command = candidates.find((candidate) => candidate === 'cargo' || fs.existsSync(candidate))
  if (command === undefined) {
    throw new Error('no cargo found: pass --cargo <path>, set DSH_OPS_CARGO, or put cargo on PATH')
  }
  // rustup keeps its toolchains beside CARGO_HOME; deriving both from the
  // executable's own location is what makes a non-PATH cargo work.
  const env = { ...process.env }
  const cargoHome = path.resolve(path.dirname(command), '..')
  if (env.CARGO_HOME === undefined && command !== 'cargo' && fs.existsSync(cargoHome)) env.CARGO_HOME = cargoHome
  const rustupHome = path.join(path.dirname(cargoHome), '.rustup')
  if (env.RUSTUP_HOME === undefined && fs.existsSync(rustupHome)) env.RUSTUP_HOME = rustupHome
  const probe = run(command, ['--version'], { env })
  context.log('build', `cargo: ${probe.stdout.trim()} (${command})`)
  return { command, env, version: probe.stdout.trim() }
}

/**
 * Build the vendored FastCtx in release mode.
 * @param {object} context - the run context.
 * @returns {Promise<object>} where the executable is and how it was built.
 */
async function stepBuild(context) {
  const pkg = context.packages.find((candidate) => candidate.kind === FASTCTX_KIND)
  const file = pkg.payload.file
  if (fs.existsSync(file) && !context.rebuild) {
    log('build', `reusing ${path.relative(REPO_ROOT, file)}`)
  } else {
    const cargo = cargoInvocation(context.cargo, context)
    log('build', `cargo build --release --locked in ${path.relative(REPO_ROOT, pkg.payload.directory)}`)
    run(cargo.command, ['build', '--release', '--locked'], { cwd: pkg.payload.directory, env: cargo.env, inherit: true })
    context.cargoVersion = cargo.version
  }
  if (!fs.existsSync(file)) throw new Error(`cargo finished without producing ${file}`)
  const sha256 = await sha256File(file)
  const bytes = fs.statSync(file).size
  log('build', `${path.relative(REPO_ROOT, file)}: ${bytes} bytes, sha256 ${sha256}`)
  return { file, bytes, sha256 }
}

// ---------------------------------------------------------------------------
// Step: assemble
// ---------------------------------------------------------------------------

/**
 * The upstream facts recorded in `vendor/fastctx/UPSTREAM.md`.
 * @returns {{upstream: string, cargoVersion: string, tag: string, commit: string}} the facts.
 */
function readUpstreamFacts() {
  const notes = fs.readFileSync(path.join(REPO_ROOT, 'vendor', 'fastctx', 'UPSTREAM.md'), 'utf8')
  const row = (label) => notes.split('\n').find((line) => line.startsWith(`| ${label} `))?.split('|')[2]?.trim()
  // The table's cells are markdown, so the version is taken as the semver-shaped
  // token inside one instead of by stripping a prefix.
  const cargoCell = row('Cargo package') ?? ''
  return {
    upstream: row('Upstream') ?? 'https://github.com/yc-duan/fastctx',
    cargoVersion: /(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)/u.exec(cargoCell)?.[1] ?? 'unknown',
    tag: /upstream release tag `([^`]+)`/u.exec(notes)?.[1] ?? 'unknown',
    commit: (row('Source commit') ?? '').replace(/`/gu, ''),
  }
}

/**
 * How the FastCtx payload was built, as a provenance source record.
 * @param {object} context - the run context.
 * @returns {object} the record.
 */
function sourcesOfCargo(context) {
  const upstream = readUpstreamFacts()
  return {
    kind: 'vendored-source-build',
    label: 'vendored FastCtx source',
    source: 'vendor/fastctx',
    upstream: upstream.upstream,
    upstreamVersion: upstream.cargoVersion,
    release: upstream.tag,
    revision: upstream.commit,
    toolchain: context.cargoVersion ?? 'prebuilt',
    profile: 'release',
    locked: true,
    license: 'Apache-2.0',
    sha256: context.build.sha256,
    bytes: context.build.bytes,
  }
}

/**
 * The `provenance.json` one package carries.
 *
 * For the payload package this is a record of a build; for a pin package it is
 * the pin itself — everything a deployment needs to fetch, verify, and unpack
 * the upstream asset without this package forwarding a byte of it.
 * @param {object} pkg - the package.
 * @param {object} context - the run context.
 * @param {object[]} sources - the upstream sources this package names.
 * @param {string} license - the SPDX expression of what the package carries.
 * @param {string} skeletonSha256 - the digest of the skeleton it was built from.
 * @returns {object} the provenance record.
 */
function provenanceFor(pkg, context, sources, license, skeletonSha256) {
  const common = {
    package: pkg.name,
    version: pkg.version,
    kind: pkg.kind,
    platform: pkg.platform,
    arch: pkg.arch,
    builtBy: 'scripts/build-platform-packages.mjs',
    builtBySha256: SCRIPT_SHA256,
    builtFromCommit: gitRevision(),
    builtAt: new Date().toISOString(),
  }
  if (pkg.payload.type === 'archive') {
    const pin = pkg.payload.pin
    return {
      ...common,
      license,
      redistributesUpstreamBytes: true,
      notice: 'Complete upstream Windows runtime, redistributed without changes. Included licenses apply to their respective components.',
      payloadSha256: pin.entrySha256,
      payloadBytes: pin.entryBytes,
      skeletonSha256,
      entryPoint: pkg.executable,
      entrySha256: pin.entrySha256,
      entryBytes: pin.entryBytes,
      entryNote: pin.entryNote,
      upstream: {
        repository: pin.upstream,
        version: pin.upstreamVersion,
        releaseTag: pin.releaseTag,
        asset: {
          name: pin.assetName,
          url: pin.assetUrl,
          sha256: pin.assetSha256,
          bytes: pin.assetBytes,
        },
        extractor: pin.extractor,
        unpacked: {
          files: pin.unpackedFiles,
          bytes: pin.unpackedBytes,
          bytesAsSumOfFileSizes: pin.unpackedBytesSumOfFileSizes,
          layout: pin.unpackedLayout,
          note: pin.unpackedNote,
        },
        license: pin.license,
        copyright: pin.copyright,
      },
      pinSource: pin.pinSource,
    }
  }
  return {
    ...common,
    license,
    redistributesUpstreamBytes: true,
    entryPoint: pkg.executable,
    payloadSha256: context.build.sha256,
    payloadBytes: context.build.bytes,
    skeletonSha256,
    sources,
  }
}

/**
 * Assemble the three package directories: payload or pin, skeleton, manifest, provenance.
 * @param {object} context - the run context.
 * @returns {Promise<object>} the assembled package facts.
 */
async function stepAssemble(context) {
  const { force } = context
  const results = []
  for (const pkg of context.packages) {
    const stage = stageDir(pkg)
    const directory = skeletonDir(pkg)
    if (!fs.existsSync(directory)) throw new Error(`missing package skeleton: ${path.relative(REPO_ROOT, directory)}`)
    const fragment = readJsonIfExists(path.join(directory, 'package.json'))
    if (fragment === undefined) throw new Error(`${path.relative(REPO_ROOT, directory)}/package.json is missing or unreadable`)
    if (fragment.name !== undefined || fragment.version !== undefined) {
      throw new Error(`${path.relative(REPO_ROOT, directory)}/package.json must not carry name/version: this script injects them`)
    }
    for (const fieldName of ['description', 'license', 'os', 'cpu']) {
      if (fragment[fieldName] === undefined) throw new Error(`${pkg.name}: the skeleton manifest has no ${fieldName}`)
    }

    const digest = skeletonDigest(directory)
    const complete = readJsonIfExists(path.join(stage, 'provenance.json'))
    if (!force && complete !== undefined && complete.skeletonSha256 === digest
      && complete.builtBySha256 === SCRIPT_SHA256
      && complete.version === pkg.version
      && (pkg.payload.type === 'archive'
        ? (complete.payloadSha256 === pkg.payload.pin.entrySha256 && fs.existsSync(path.join(stage, pkg.executable)))
        : (complete.payloadSha256 === context.build.sha256 && fs.existsSync(path.join(stage, pkg.executable))))) {
      log('assemble', `reusing ${pkg.name} (${pkg.payload.type})`)
      results.push({ pkg, stage, provenance: complete })
      continue
    }

    log('assemble', `assembling ${pkg.name} (${pkg.payload.type})`)
    fs.rmSync(stage, { recursive: true, force: true })
    fs.mkdirSync(stage, { recursive: true })

    if (pkg.payload.type === 'archive') {
      const pin = pkg.payload.pin
      const archive = path.join(context.dist, 'downloads', pin.assetName)
      if (!fs.existsSync(archive) || await sha256File(archive) !== pin.assetSha256) {
        throw new Error(`Missing verified archive: ${archive}; run fetch first`)
      }
      if (pin.extractor === 'zip') {
        const into = path.join(stage, 'bin')
        fs.mkdirSync(into, { recursive: true })
        run(path.join(process.env.SystemRoot ?? 'C:/Windows', 'System32/tar.exe'), ['-xf', archive, '-C', into])
      } else if (pin.extractor === 'sfx-7z') {
        run(archive, [`-o${stage}`, '-y'])
      } else throw new Error(`Unsupported archive extractor: ${pin.extractor}`)
      if (await sha256File(path.join(stage, pkg.executable)) !== pin.entrySha256) throw new Error(`Executable digest mismatch: ${pkg.name}`)
      // npm registry rejects tar hardlinks. Materialize each linked path as a
      // regular independent file without changing its bytes or runtime layout.
      for (const relative of treeFiles(stage)) {
        const file = path.join(stage, relative)
        if (fs.statSync(file).nlink > 1) {
          const temporary = `${file}.dsh-ops-materialize`
          fs.copyFileSync(file, temporary)
          fs.unlinkSync(file)
          fs.renameSync(temporary, file)
        }
      }
    }

    if (pkg.payload.type === 'cargo') {
      const target = path.join(stage, pkg.executable)
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.copyFileSync(pkg.payload.file, target)
      // Apache-2.0 obligations for a redistributed binary: the licence, the
      // upstream NOTICE, the record of what this fork changed, and the
      // third-party licence inventory all travel with the executable.
      const vendor = path.join(REPO_ROOT, 'vendor', 'fastctx')
      for (const [from, to] of [
        ['LICENSE-APACHE', 'LICENSE'],
        ['NOTICE', 'NOTICE'],
        ['FORK.md', 'FORK.md'],
        ['UPSTREAM.md', 'UPSTREAM.md'],
        ['THIRD_PARTY_LICENSES_RUST.md', 'THIRD_PARTY_LICENSES_RUST.md'],
        ['THIRD_PARTY_LICENSES.md', 'THIRD_PARTY_LICENSES.md'],
      ]) {
        const source = path.join(vendor, from)
        if (fs.existsSync(source)) fs.copyFileSync(source, path.join(stage, to))
      }
    }

    const provenance = provenanceFor(
      pkg,
      context,
      pkg.payload.type === 'cargo' ? [sourcesOfCargo(context)] : [],
      fragment.license,
      digest,
    )
    writeJson(path.join(stage, 'provenance.json'), provenance)

    // The skeleton's own files land last: the payload never overwrites a
    // committed licence or notice, and a collision is a stopped release rather
    // than a silently mixed package.
    for (const entry of fs.readdirSync(directory).sort()) {
      const from = path.join(directory, entry)
      const to = path.join(stage, entry)
      if (entry === 'package.json') continue
      if (fs.existsSync(to)) throw new Error(`${pkg.name}: skeleton file ${entry} collides with the extracted payload`)
      copyEntry(from, to)
    }
    writeJson(path.join(stage, 'package.json'), { name: pkg.name, version: pkg.version, ...fragment })

    log('assemble', `${pkg.name}@${pkg.version}: ${pkg.executable} sha256 ${provenance.payloadSha256}`)
    if (pkg.payload.type === 'cargo') {
      const provenanceWithPayload = readJsonIfExists(path.join(stage, 'provenance.json'))
      results.push({ pkg, stage, provenance: provenanceWithPayload ?? provenance })
    } else {
      results.push({ pkg, stage, provenance: readJsonIfExists(path.join(stage, 'provenance.json')) ?? provenance })
    }
  }
  return results
}

// ---------------------------------------------------------------------------
// Step: pack (and the release-wide records)
// ---------------------------------------------------------------------------

/**
 * Pack one package directory and return what npm reported.
 * @param {string} directory - the package directory.
 * @param {string} dist - where the tarball lands.
 * @returns {Promise<object>} the tarball facts.
 */
async function packDirectory(directory, dist) {
  const result = npm(['pack', '--ignore-scripts', '--pack-destination', dist, '--json'], { cwd: directory })
  const [reported] = parseNpmJson(result.stdout, `npm pack in ${directory}`)
  const tarball = path.join(dist, reported.filename)
  return {
    tarball: reported.filename,
    path: tarball,
    bytes: fs.statSync(tarball).size,
    sha256: await sha256File(tarball),
    unpackedBytes: reported.unpackedSize,
    files: Array.isArray(reported.files) ? reported.files.length : undefined,
  }
}

/**
 * Pack every assembled package and rewrite the release records.
 * @param {object} context - the run context.
 * @param {object[]} assembled - the assembled packages.
 * @returns {Promise<object>} the tarball facts per package.
 */
async function stepPack(context, assembled) {
  const tarballs = context.tarballs ?? {}
  for (const { pkg, stage } of assembled) {
    const packed = await packDirectory(stage, context.dist)
    tarballs[pkg.kind] = packed
    log('pack', `${packed.tarball}: ${size(packed.bytes)} packed, ${size(packed.unpackedBytes)} unpacked, `
      + `${String(packed.files)} files, sha256 ${packed.sha256}`)
  }
  context.tarballs = tarballs
  await writeReleaseRecords(context, assembled)
  return tarballs
}

/**
 * Write `SHA256SUMS`, the release-wide `provenance.json`, and the publish plan.
 *
 * `SHA256SUMS` is the `sha256sum -c` format on purpose: it is the file an
 * offline installer verifies the released assets against, and it is uploaded to
 * the release as an asset of its own.
 *
 * @param {object} context - the run context.
 * @param {object[]} assembled - the assembled packages.
 * @returns {Promise<void>} nothing.
 */
async function writeReleaseRecords(context, assembled) {
  const { dist } = context
  const byKind = new Map(assembled.map((entry) => [entry.pkg.kind, entry]))
  const packages = []
  for (const pkg of context.packages) {
    const packed = context.tarballs?.[pkg.kind]
    const entry = byKind.get(pkg.kind)
    if (packed === undefined || entry === undefined) continue
    const provenance = entry.provenance ?? {}
    const upstream = provenance.upstream ?? {}
    const asset = upstream.asset ?? {}
    const isPin = pkg.payload.type === 'archive'
    packages.push({
      name: pkg.name,
      kind: pkg.kind,
      version: pkg.version,
      // Where the bytes come from: an upstream release asset for a pin, the
      // vendored source tree for the payload package.
      sourceUrl: isPin ? asset.url : provenance.sources?.[0]?.upstream,
      sourceSha256: isPin ? asset.sha256 : provenance.sources?.[0]?.sha256,
      sourceBytes: isPin ? asset.bytes : provenance.sources?.[0]?.bytes,
      upstreamVersion: isPin ? upstream.version : provenance.sources?.[0]?.upstreamVersion,
      upstreamRelease: isPin ? upstream.releaseTag : provenance.sources?.[0]?.release,
      // What the pinned asset unpacks to, measured rather than estimated: this
      // is the footprint a deployment takes on when it resolves the shell.
      upstreamUnpackedFiles: upstream.unpacked?.files,
      upstreamUnpackedBytes: upstream.unpacked?.bytes,
      upstreamUnpackedBytesAsSumOfFileSizes: upstream.unpacked?.bytesAsSumOfFileSizes,
      license: provenance.license,
      redistributesUpstreamBytes: true,
      entryPoint: pkg.executable,
      payloadSha256: provenance.payloadSha256 ?? provenance.entrySha256,
      payloadBytes: provenance.payloadBytes ?? provenance.entryBytes,
      tarball: packed.tarball,
      tarballSha256: packed.sha256,
      bytes: packed.bytes,
      unpackedBytes: packed.unpackedBytes,
      files: packed.files,
    })
  }
  const files = fs.readdirSync(dist).filter((name) => name.endsWith('.tgz')).sort()
  const sums = []
  for (const name of files) sums.push(`${await sha256File(path.join(dist, name))}  ${name}`)
  fs.writeFileSync(path.join(dist, 'SHA256SUMS'), `${sums.join('\n')}${sums.length === 0 ? '' : '\n'}`)
  writeJson(path.join(dist, 'provenance.json'), {
    generatedBy: 'scripts/build-platform-packages.mjs',
    commit: gitRevision(),
    mainPackage: {
      name: mainManifest().name,
      version: mainManifest().version,
      ...context.plan === undefined
        ? {}
        : {
          tarball: path.basename(context.plan.mainTarball),
          tarballSha256: context.plan.mainTarballSha256,
          bytes: context.plan.mainTarballBytes,
          unpackedBytes: context.plan.mainUnpackedBytes,
          files: context.plan.mainFiles,
        },
    },
    packages,
    tarballs: files,
  })
  const plan = readJsonIfExists(path.join(dist, 'publish-plan.json')) ?? {}
  writeJson(path.join(dist, 'publish-plan.json'), {
    ...plan,
    version: mainManifest().version,
    sha256sums: 'SHA256SUMS',
    provenance: 'provenance.json',
    platformTarballs: context.packages
      .map((pkg) => context.tarballs?.[pkg.kind]?.path)
      .filter((value) => value !== undefined),
    // Name, version, and tarball together: a re-run of the release job can ask
    // the registry whether that exact version is already published and skip it,
    // instead of failing the whole release on a package that got through before
    // something later in the pipeline did not.
    platformPackages: packages.map((entry) => ({
      name: entry.name,
      version: entry.version,
      tarball: path.join(dist, entry.tarball),
      sha256: entry.tarballSha256,
      carriesPayload: entry.redistributesUpstreamBytes,
    })),
    ...context.plan ?? {},
  })
}

/**
 * Print the artifact table from the release-wide `provenance.json`.
 *
 * This is the table a release report is written from: what is published, how
 * large each tarball is packed and unpacked, how many files it carries, and the
 * digest of the exact bytes that would be uploaded.
 * @param {string} dist - the artifact directory.
 * @returns {void}
 */
function printArtifactTable(dist) {
  const record = readJsonIfExists(path.join(dist, 'provenance.json'))
  if (record === undefined) return
  const rows = (record.packages ?? []).map((entry) => [
    entry.name, entry.version, entry.tarball, size(entry.bytes), size(entry.unpackedBytes),
    String(entry.files ?? '?'), entry.tarballSha256,
  ])
  const main = record.mainPackage ?? {}
  if (main.tarball !== undefined) {
    rows.push([
      main.name, main.version, main.tarball, size(main.bytes), size(main.unpackedBytes),
      String(main.files ?? '?'), main.tarballSha256,
    ])
  }
  console.log(`\nrelease artifacts (${path.join(dist, 'provenance.json')}):`)
  console.log(`  ${'package'.padEnd(30)} ${'version'.padEnd(7)} ${'tarball'.padEnd(42)} `
    + `${'packed'.padStart(9)} ${'unpacked'.padStart(10)} ${'files'.padStart(6)}  sha256`)
  for (const row of rows) {
    console.log(`  ${row[0].padEnd(30)} ${row[1].padEnd(7)} ${row[2].padEnd(42)} `
      + `${row[3].padStart(9)} ${row[4].padStart(10)} ${row[5].padStart(6)}  ${row[6]}`)
  }
  console.log()
}

// ---------------------------------------------------------------------------
// Step: publish directory (the manifest that is actually published)
// ---------------------------------------------------------------------------

/**
 * The `optionalDependencies` a publish would inject.
 *
 * Exact Windows runtime optionalDependencies, injected only in the publish
 * artifact so an unpublished version does not break contributor installs.
 *
 * @param {object} context - the run context.
 * @returns {Record<string, string>} the map.
 */
function injectedOptionalDependencies(context) {
  const declared = mainManifest().optionalDependencies ?? {}
  const injected = { ...declared }
  for (const pkg of context.packages) {
    injected[pkg.name] = pkg.version
  }
  return injected
}

/**
 * Print the injected map, so a human can check it before anything is published.
 * @param {object} context - the run context.
 * @returns {void}
 */
function printInjection(context) {
  const manifest = mainManifest()
  const injected = injectedOptionalDependencies(context)
  console.log(`\ninjected optionalDependencies for ${manifest.name}@${manifest.version}:`)
  for (const [name, range] of Object.entries(injected)) {
    const own = context.packages.some((pkg) => pkg.name === name)
    console.log(`  ${own ? '+' : ' '} ${name}: ${range}`)
  }
  console.log('  (+ marks a platform package this release injects; the rest came from the committed manifest)')
  console.log('  (all three platform packages carry ready-to-run Windows binaries)')
  console.log('  (lib/binary.js resolves this plugin\'s own FastCtx package ahead of the upstream @fastctx/* fallbacks)\n')
}

/**
 * Build the publish directory: the main package's exact published content plus
 * the injected platform dependencies, then pack it.
 * @param {object} context - the run context.
 * @param {object[]} assembled - the assembled packages.
 * @returns {Promise<object>} the publish directory facts.
 */
async function stepPublishDir(context, assembled) {
  // Release packages must contain every advertised native target. A one-host
  // source build is sufficient for local use, never for a cross-platform release.
  run(process.execPath, [path.join(REPO_ROOT, 'bin/native-runtime.mjs'), 'check'])
  const manifest = mainManifest()
  const directory = path.join(context.dist, 'publish', `${manifest.name}-${manifest.version}`)
  if (fs.existsSync(directory)) fs.rmSync(directory, { recursive: true, force: true })
  fs.mkdirSync(directory, { recursive: true })

  // npm's own answer to "what would this package publish" is the copy list: the
  // whitelist in `files` is then checked against it instead of being
  // re-implemented here (globs, always-included files, and ignore rules all
  // come from npm alone).
  const dryRun = npm(['pack', '--dry-run', '--json'], { cwd: REPO_ROOT })
  const [report] = parseNpmJson(dryRun.stdout, 'npm pack --dry-run')
  const listed = (report.files ?? []).map((entry) => entry.path).sort()
  if (listed.length === 0) throw new Error('npm pack --dry-run listed no files')
  for (const entry of listed) copyEntry(path.join(REPO_ROOT, entry), path.join(directory, entry))

  const whitelist = manifest.files ?? []
  const uncovered = whitelist.filter((entry) => !listed.some((file) => file === entry || file.startsWith(`${entry}/`)))
  if (uncovered.length > 0) {
    throw new Error(`the files whitelist names ${uncovered.join(', ')}, which npm would not publish`)
  }

  const publishable = { ...manifest, optionalDependencies: injectedOptionalDependencies(context) }
  // `private: true` guards the checkout against an accidental publish; this
  // directory is the artifact that is meant to be published, so the flag does
  // not travel with it (npm refuses a tarball whose manifest is private).
  delete publishable.private
  writeJson(path.join(directory, 'package.json'), publishable)
  const packed = await packDirectory(directory, context.dist)
  log('publish-dir', `${path.relative(REPO_ROOT, directory)}: ${listed.length} files copied, tarball ${packed.tarball} `
    + `(${size(packed.bytes)} packed, ${size(packed.unpackedBytes)} unpacked, sha256 ${packed.sha256})`)
  context.plan = {
    mainName: manifest.name,
    mainVersion: manifest.version,
    mainPublishDir: directory,
    mainTarball: packed.path,
    mainTarballBytes: packed.bytes,
    mainTarballSha256: packed.sha256,
    mainUnpackedBytes: packed.unpackedBytes,
    mainFiles: packed.files,
  }
  await writeReleaseRecords(context, assembled)
  return context.plan
}

// ---------------------------------------------------------------------------
// Step: fetch and verify-upstream
// ---------------------------------------------------------------------------

/**
 * Download the pinned upstream assets, verifying each against its pin.
 * @param {object} context - the run context.
 * @param {object} options - what to do with them.
 * @param {boolean} options.keep - keep the archives on disk, or delete them again.
 * @returns {Promise<object[]>} one verdict per pinned asset.
 */
async function downloadPins(context, { keep }) {
  const directory = path.join(context.dist, 'downloads')
  fs.mkdirSync(directory, { recursive: true })
  const verdicts = []
  for (const pkg of context.packages) {
    if (pkg.payload.type !== 'archive') continue
    const pin = pkg.payload.pin
    const file = path.join(directory, pin.assetName)
    let digest = null
    let bytes = null
    if (!context.force && fs.existsSync(file)) {
      digest = await sha256File(file)
      bytes = fs.statSync(file).size
      log('fetch', `reusing ${pin.assetName} (${bytes} bytes, sha256 ${digest})`)
    } else {
      log('fetch', `downloading ${pin.assetUrl}`)
      const result = await download(pin.assetUrl, file, { proxy: context.proxy, expectedBytes: pin.assetBytes })
      digest = result.sha256
      bytes = result.bytes
      log('fetch', `downloaded ${pin.assetName} (${bytes} bytes, sha256 ${digest})`)
    }
    const matches = digest === pin.assetSha256 && bytes === pin.assetBytes
    verdicts.push({ package: pkg.name, pin, file, digest, bytes, matches })
    if (!matches) {
      throw new Error(`${pin.assetName} does not match its pin: expected sha256 ${pin.assetSha256} and `
        + `${pin.assetBytes} bytes, got sha256 ${digest} and ${bytes} bytes`)
    }
    log(keep ? 'fetch' : 'verify-upstream', `${pin.assetName} matches its pin (sha256 ${digest}, ${bytes} bytes)`)
    if (!keep) {
      fs.rmSync(file, { force: true })
      log('verify-upstream', `deleted ${pin.assetName}; this pipeline keeps no upstream bytes`)
    }
  }
  if (keep) {
    writeJson(path.join(directory, 'sources.json'), {
      verifiedAt: new Date().toISOString(),
      assets: verdicts.map((verdict) => ({
        package: verdict.package,
        url: verdict.pin.assetUrl,
        file: verdict.pin.assetName,
        sha256: verdict.digest,
        bytes: verdict.bytes,
        matchesPin: verdict.matches,
      })),
    })
  }
  return verdicts
}

/**
 * Prove every pin still matches the upstream release it names.
 * @param {object} context - the run context.
 * @returns {Promise<void>} nothing.
 */
async function stepVerifyUpstream(context) {
  log('verify-upstream', 'downloading every pinned asset, verifying its digest, and deleting it again')
  const verdicts = await downloadPins(context, { keep: false })
  console.log(`\nupstream pins verified (${verdicts.length}):`)
  for (const verdict of verdicts) {
    console.log(`  ${verdict.package.padEnd(30)} ${verdict.pin.releaseTag.padEnd(18)} ${verdict.pin.assetName}`)
    console.log(`  ${''.padEnd(30)} sha256 ${verdict.pin.assetSha256}  ${verdict.pin.assetBytes} bytes  OK`)
  }
  console.log()
}

// ---------------------------------------------------------------------------
// Step: check (no download, no build)
// ---------------------------------------------------------------------------

/**
 * Verify every artifact this release would publish, without producing any.
 * @param {object} context - the run context.
 * @returns {Promise<number>} the number of problems found.
 */
async function stepCheck(context) {
  const { dist } = context
  const problems = []
  const ok = (scope, message) => console.log(`  ok      ${scope.padEnd(11)} ${message}`)
  /**
   * Record one failure.
   * @param {string} scope - the area.
   * @param {string} message - what is missing or wrong.
   * @returns {void}
   */
  const missing = (scope, message) => {
    problems.push(`${scope}: ${message}`)
    console.log(`  MISSING ${scope.padEnd(11)} ${message}`)
  }
  console.log(`\ncheck: ${dist}`)

  // 1. The pins, printed in full: this is the list a human reconciles against
  //    the upstream release pages, and the only place a fallback pin shows up.
  console.log('  pins this release publishes:')
  for (const pkg of context.packages) {
    if (pkg.payload.type !== 'archive') continue
    const pin = pkg.payload.pin
    console.log(`    ${pkg.name} -> ${pin.upstream} ${pin.releaseTag}`)
    console.log(`      asset   ${pin.assetName} ${pin.assetBytes} bytes`)
    console.log(`      url     ${pin.assetUrl}`)
    console.log(`      sha256  ${pin.assetSha256}`)
    console.log(`      entry   ${pin.entryPoint} sha256 ${pin.entrySha256} (${pin.entryBytes} bytes)`)
    console.log(`      unpacked ${pin.unpackedFiles} files, ${pin.unpackedBytes} bytes (${size(pin.unpackedBytes)})`
      + (pin.unpackedBytesSumOfFileSizes === pin.unpackedBytes
        ? ''
        : `; sum of file sizes ${pin.unpackedBytesSumOfFileSizes}`))
    console.log(`      licence ${pin.license} - ${pin.copyright}`)
    console.log(`      source  ${pin.pinSource}`)
  }

  const recorded = readJsonIfExists(path.join(dist, 'downloads', 'sources.json'))
  if (recorded !== undefined) {
    ok('download', `downloads/sources.json records ${(recorded.assets ?? []).length} verified asset(s)`)
  }

  // The payload package's own pin: where its source came from, what built it,
  // and the digest of the executable. Printed beside the shell pins so one list
  // answers "what is in this release, and where did every byte come from".
  for (const pkg of context.packages) {
    if (pkg.payload.type !== 'cargo') continue
    const provenance = readJsonIfExists(path.join(stageDir(pkg), 'provenance.json'))
    const source = provenance?.sources?.[0] ?? {}
    console.log(`    ${pkg.name} -> ${source.upstream ?? 'vendor/fastctx'} ${source.release ?? ''}`.trimEnd())
    console.log(`      source  ${source.source ?? 'vendor/fastctx'} (profile ${source.profile ?? 'release'}, `
      + `locked ${String(source.locked ?? true)}, toolchain ${source.toolchain ?? 'not recorded'})`)
    console.log(`      sha256  ${provenance?.payloadSha256 ?? '(not assembled)'} (${String(provenance?.payloadBytes ?? '?')} bytes)`)
    console.log(`      revision ${source.revision ?? 'not recorded'}`)
  }

  // 2. The payload package's executable.
  const buildFile = context.packages[0].payload.file
  const build = fs.existsSync(buildFile)
    ? { file: buildFile, sha256: await sha256File(buildFile), bytes: fs.statSync(buildFile).size }
    : undefined
  if (build === undefined) missing('build', `${path.relative(REPO_ROOT, buildFile)} does not exist`)
  else ok('build', `${path.relative(REPO_ROOT, buildFile)} (${size(build.bytes)}, sha256 ${build.sha256})`)

  // 3. Every stage: digests for the payload package, and the no-bytes invariant
  //    for the pins.
  const assembled = []
  for (const pkg of context.packages) {
    const stage = stageDir(pkg)
    const provenance = readJsonIfExists(path.join(stage, 'provenance.json'))
    if (provenance === undefined) {
      missing('stage', `${pkg.name} is not assembled (${path.relative(dist, stage)}/provenance.json)`)
      continue
    }
    const files = treeFiles(stage)
    if (pkg.payload.type === 'archive' && provenance.upstream?.asset?.sha256 !== pkg.payload.pin.assetSha256) {
      missing('stage', `${pkg.name} upstream archive digest differs from its pin`)
    }
    {
      const entry = path.join(stage, pkg.executable)
      if (!fs.existsSync(entry)) {
        missing('stage', `${pkg.name} has no ${pkg.executable}`)
      } else {
        const sha256 = await sha256File(entry)
        if (sha256 !== provenance.payloadSha256) {
          missing('stage', `${pkg.name} ${pkg.executable} hashes to ${sha256}, provenance says ${provenance.payloadSha256}`)
        } else {
          ok('stage', `${pkg.name}@${provenance.version} ${pkg.executable} (${size(fs.statSync(entry).size)}, sha256 ${sha256})`)
        }
      }
    }
    if (provenance.version !== mainManifest().version) {
      missing('stage', `${pkg.name} records version ${provenance.version}, the package is at ${mainManifest().version}`)
    }
    assembled.push({ pkg, stage, provenance })
  }

  // 4. The tarballs, against the checksum manifest.
  const sumsFile = path.join(dist, 'SHA256SUMS')
  const sums = new Map()
  if (!fs.existsSync(sumsFile)) {
    missing('tarball', 'SHA256SUMS is not written')
  } else {
    for (const line of fs.readFileSync(sumsFile, 'utf8').split('\n')) {
      const match = /^([0-9a-f]{64}) {2}(.+)$/u.exec(line.trim())
      if (match !== null) sums.set(match[2], match[1])
    }
  }
  context.tarballs = context.tarballs ?? {}
  const expectedTarballs = []
  for (const { pkg } of assembled) {
    // npm names a tarball after the package name with the scope marker removed
    // and the separator replaced (`@scope/name` -> `scope-name-<version>.tgz`),
    // so the expected file is derived, not searched for.
    const tarball = `${pkg.name.replace(/^@/u, '').replace(/\//gu, '-')}-${pkg.version}.tgz`
    expectedTarballs.push(tarball)
    if (!fs.existsSync(path.join(dist, tarball))) {
      missing('tarball', `${pkg.name} is not packed (expected ${tarball})`)
      continue
    }
    const sha256 = await sha256File(path.join(dist, tarball))
    const bytes = fs.statSync(path.join(dist, tarball)).size
    if (sums.size > 0 && sums.get(tarball) !== sha256) {
      missing('tarball', `${tarball} hashes to ${sha256}, SHA256SUMS says ${String(sums.get(tarball))}`)
    } else {
      ok('tarball', `${tarball} (${size(bytes)}, sha256 ${sha256})`)
    }
    context.tarballs[pkg.kind] = { tarball, path: path.join(dist, tarball), bytes, sha256 }
  }

  // The manifest has to describe exactly this release's artifacts and nothing
  // else: an entry left over from an earlier build is a digest waiting to be
  // trusted about bytes that are no longer there, and an artifact missing from
  // it cannot be verified offline at all.
  const mainTarballName = `${mainManifest().name}-${mainManifest().version}.tgz`
  if (fs.existsSync(path.join(dist, mainTarballName))) expectedTarballs.push(mainTarballName)
  if (sums.size > 0) {
    const extra = [...sums.keys()].filter((name) => !expectedTarballs.includes(name))
    const unlisted = expectedTarballs.filter((name) => fs.existsSync(path.join(dist, name)) && !sums.has(name))
    if (extra.length > 0) {
      missing('checksums', `SHA256SUMS lists ${extra.join(', ')}, which this release does not produce`)
    }
    if (unlisted.length > 0) missing('checksums', `SHA256SUMS omits ${unlisted.join(', ')}`)
    if (extra.length === 0 && unlisted.length === 0) {
      ok('checksums', `SHA256SUMS lists exactly the ${sums.size} artifact(s) this release produces`)
    }
  }

  // 5. The publish directory and the main tarball.
  const manifest = mainManifest()
  const publishDir = path.join(dist, 'publish', `${manifest.name}-${manifest.version}`)
  const publishManifest = readJsonIfExists(path.join(publishDir, 'package.json'))
  const mainTarball = path.join(dist, `${manifest.name}-${manifest.version}.tgz`)
  if (publishManifest === undefined) {
    missing('publish', `${path.relative(dist, publishDir)}/package.json does not exist`)
  } else {
    const expected = injectedOptionalDependencies(context)
    const injected = publishManifest.optionalDependencies ?? {}
    const wrong = Object.entries(expected).filter(([name, range]) => injected[name] !== range)
    const unexpected = Object.keys(injected).filter((name) => expected[name] === undefined)
    if (wrong.length > 0 || unexpected.length > 0) {
      missing('publish', 'injected optionalDependencies differ: '
        + `${wrong.map(([name, range]) => `${name} should be ${range}, is ${String(injected[name])}`).join('; ')}`
        + (unexpected.length === 0 ? '' : `; unexpected ${unexpected.join(', ')}`))
    } else {
      ok('publish', `${path.relative(dist, publishDir)} injects ${Object.keys(expected).length} optionalDependencies`)
    }
    if (publishManifest.private === true) {
      missing('publish', `${path.relative(dist, publishDir)}/package.json is still private, so npm would refuse it`)
    } else {
      ok('publish', `${path.relative(dist, publishDir)} carries no private flag`)
    }
  }
  if (!fs.existsSync(mainTarball)) missing('publish', `${path.basename(mainTarball)} is not packed`)
  else if (sums.size > 0 && sums.get(path.basename(mainTarball)) !== await sha256File(mainTarball)) {
    missing('publish', `${path.basename(mainTarball)} is not the digest SHA256SUMS records`)
  } else {
    ok('publish', `${path.basename(mainTarball)} (${size(fs.statSync(mainTarball).size)})`)
  }

  // 6. The release-wide record.
  const releaseProvenance = readJsonIfExists(path.join(dist, 'provenance.json'))
  if (releaseProvenance === undefined) missing('provenance', 'provenance.json is not written')
  else if ((releaseProvenance.packages ?? []).length !== context.packages.length) {
    missing('provenance', `provenance.json lists ${String((releaseProvenance.packages ?? []).length)} packages, expected ${context.packages.length}`)
  } else if ((releaseProvenance.packages ?? []).some((entry) => entry.version !== manifest.version)) {
    missing('provenance', `provenance.json carries a package whose version is not ${manifest.version}`)
  } else {
    ok('provenance', `provenance.json lists ${releaseProvenance.packages.length} packages at ${manifest.version}`)
  }

  printInjection(context)
  if (problems.length > 0) {
    console.log(`check: ${problems.length} problem(s); nothing was downloaded or built`)
    for (const problem of problems) console.log(`  - ${problem}`)
    return problems.length
  }
  console.log('check: every artifact the release publishes is present and matches its recorded digest')
  return 0
}

// ---------------------------------------------------------------------------
// Command line
// ---------------------------------------------------------------------------

/**
 * Parse the command line.
 * @param {string[]} argv - `process.argv.slice(2)`.
 * @returns {object} the parsed options.
 */
function parseArgs(argv) {
  const commands = new Set(['all', 'build', 'assemble', 'pack', 'publish-dir', 'check', 'fetch', 'verify-upstream'])
  const options = {
    command: 'all',
    platform: 'win32',
    arch: 'x64',
    dist: path.resolve(REPO_ROOT, '..', 'dist'),
    cargo: undefined,
    proxy: undefined,
    noProxy: false,
    force: false,
    rebuild: false,
  }
  const flags = new Set()
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (!argument.startsWith('--')) {
      if (commands.has(argument)) options.command = argument
      else throw new Error(`unknown command: ${argument}`)
      continue
    }
    const [name, inline] = argument.includes('=')
      ? [argument.slice(0, argument.indexOf('=')), argument.slice(argument.indexOf('=') + 1)]
      : [argument, undefined]
    /**
     * The value of a flag that needs one.
     * @returns {string} the value.
     */
    const value = () => {
      if (inline !== undefined) return inline
      index += 1
      if (index >= argv.length) throw new Error(`${name} needs a value`)
      return argv[index]
    }
    switch (name) {
      case '--platform': options.platform = value(); break
      case '--arch': options.arch = value(); break
      case '--dist': options.dist = path.resolve(value()); break
      case '--cargo': options.cargo = value(); break
      case '--proxy': options.proxy = value(); break
      case '--no-proxy': options.noProxy = true; break
      case '--force': options.force = true; break
      case '--rebuild': options.rebuild = true; break
      case '--check': options.command = 'check'; break
      case '--verify-upstream': options.command = 'verify-upstream'; break
      case '--help': flags.add('help'); break
      default: throw new Error(`unknown flag: ${name}`)
    }
  }
  return { ...options, help: flags.has('help') }
}

/** Print the usage block, taken from this file's own header. */
function printUsage() {
  const source = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8')
  const start = source.indexOf(' * Usage:')
  const end = source.indexOf(' * @module')
  console.log(source.slice(start + 3, end).replace(/^ \* ?/gmu, '').trimEnd())
}

/**
 * Run the requested command.
 * @returns {Promise<void>} nothing.
 */
async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help === true) {
    printUsage()
    return
  }
  const proxy = resolveProxy(options.proxy, options.noProxy)
  const context = {
    ...options,
    proxy,
    packages: describePackages(options.platform, options.arch, options.dist),
  }
  console.log(`dsh-ops platform packages: ${options.command} -> ${options.dist}`)
  console.log(`target ${options.platform}-${options.arch}`
    + (proxy === undefined ? ' (no proxy)' : ` (proxy http://${proxy.host}:${proxy.port})`))
  console.log(`platform packages: ${context.packages.map((pkg) => `${pkg.name}@${pkg.version}`).join(', ')}`)

  const runStep = async (name, body) => {
    log(name, 'start')
    return body()
  }

  if (options.command === 'check') {
    const problems = await stepCheck(context)
    printArtifactTable(options.dist)
    process.exitCode = problems === 0 ? 0 : 1
    return
  }
  if (options.command === 'verify-upstream') {
    await runStep('verify-upstream', () => stepVerifyUpstream(context))
    return
  }
  if (options.command === 'fetch') {
    await runStep('fetch', () => downloadPins(context, { keep: true }))
    log('fetch', 'pinned assets are in place; `check` and `assemble` need none of them')
    return
  }

  let assembled = []
  if (['all', 'build', 'assemble', 'pack', 'publish-dir'].includes(options.command)) {
    context.build = await runStep('build', () => stepBuild(context))
  }
  if (['all', 'assemble', 'pack', 'publish-dir'].includes(options.command)) {
    await runStep('fetch', () => downloadPins(context, { keep: true }))
    assembled = await runStep('assemble', () => stepAssemble(context))
  }
  if (['all', 'pack', 'publish-dir'].includes(options.command)) {
    await runStep('pack', () => stepPack(context, assembled))
  }
  if (['all', 'publish-dir'].includes(options.command)) {
    await runStep('publish-dir', () => stepPublishDir(context, assembled))
  }
  if (options.command === 'all') {
    const problems = await stepCheck(context)
    if (problems > 0) throw new Error(`${problems} artifact(s) failed the post-build check`)
  }
  printArtifactTable(options.dist)
  log('done', `artifacts in ${options.dist}`)
}

await main().catch((error) => {
  console.error(`\nbuild-platform-packages: ${String(error?.message ?? error)}`)
  process.exitCode = 1
})
