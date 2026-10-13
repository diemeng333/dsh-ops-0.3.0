/**
 * Binary resolution: the search order, and what a failure tells the operator.
 *
 * Every scenario builds its own tree under the runner's temporary home, so the
 * order is proven against real files rather than against a mock of `fs`. The
 * package steps are forged too, for one pinned platform: after the platform
 * packages became a release-time injection, a checkout is not guaranteed to
 * have either of them installed, and a suite that asserted "this machine has
 * one" would be testing the developer's laptop.
 */

import fs from 'node:fs'
import path from 'node:path'
import {
  BINARY_ENV,
  BinaryNotFoundError,
  executableName,
  managedBinaryFile,
  opsFastctxPackage,
  opsFastctxPackageBinary,
  pathBinary,
  platformPackageBinary,
  probeBinary,
  resolveBinary,
} from '../lib/binary.js'
import { assert, report, test, withTempDir } from './lib/harness.mjs'

/**
 * Create a file with the given bytes, plus its parent directories.
 * @param {string} file - the path to create.
 * @param {string} [contents] - the bytes.
 * @returns {string} the created path.
 */
function seed(file, contents = 'stub') {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, contents)
  return file
}

/**
 * The platform the package-layout fixtures are forged for.
 *
 * Pinned rather than read from `process`: the subject is the order the chain
 * resolves package layouts in, and both package steps are the same code on every
 * host, so a tree of files for one target proves it everywhere.
 */
const FORGED = Object.freeze({
  platform: 'win32',
  arch: 'x64',
  executable: executableName('win32'),
  own: opsFastctxPackage('win32', 'x64'),
  upstream: '@fastctx/win32-x64',
})

/**
 * Forge one platform package under one package root, without installing
 * anything: a directory with a manifest and, when asked for, the executable the
 * resolver looks for.
 * @param {string} root - the package root to write.
 * @param {string} name - the package name.
 * @param {object} [shape] - how the package is present.
 * @param {boolean} [shape.installed] - create the package directory at all.
 * @param {boolean} [shape.binary] - write its `bin/<executable>` as well.
 * @param {boolean} [shape.declared] - declare the package in the root manifest.
 * @returns {string|undefined} the executable the resolver should find, when one was written.
 */
function stagePackage(root, name, { installed = true, binary = true, declared = false } = {}) {
  fs.mkdirSync(root, { recursive: true })
  const manifestFile = path.join(root, 'package.json')
  const previous = fs.existsSync(manifestFile)
    ? JSON.parse(fs.readFileSync(manifestFile, 'utf8'))
    : { name: 'dsh-ops', version: '0.1.0' }
  fs.writeFileSync(manifestFile, JSON.stringify({
    ...previous,
    optionalDependencies: {
      ...previous.optionalDependencies,
      ...declared ? { [name]: '0.1.0' } : {},
    },
  }))
  if (!installed) return undefined
  const packageDir = path.join(root, 'node_modules', ...name.split('/'))
  fs.mkdirSync(packageDir, { recursive: true })
  fs.writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify({ name, version: '0.1.0' }))
  return binary ? seed(path.join(packageDir, 'bin', FORGED.executable)) : undefined
}

/**
 * Forge this distribution's own FastCtx platform package under one package root.
 * @param {string} root - the package root.
 * @param {object} [shape] - how the package is present; see {@link stagePackage}.
 * @returns {string|undefined} the forged executable.
 */
function stageOwnPackage(root, shape) {
  return stagePackage(root, FORGED.own, shape)
}

/**
 * Forge the upstream `@fastctx/<platform>-<arch>` package under one package root.
 * @param {string} root - the package root.
 * @param {object} [shape] - how the package is present; see {@link stagePackage}.
 * @returns {string|undefined} the forged executable.
 */
function stageUpstreamPackage(root, shape) {
  return stagePackage(root, FORGED.upstream, shape)
}

/**
 * Whether the search resolves one forged package out of one root, asked
 * directly: the order assertions need to know the loser was really there.
 * @param {string} root - the package root.
 * @param {string} name - the package name.
 * @returns {string|undefined} the executable, when the package is installed there.
 */
function forgedBinary(root, name) {
  const found = name === FORGED.own
    ? opsFastctxPackageBinary({ ...FORGED, packageRoot: root })
    : platformPackageBinary({ ...FORGED, root })
  return 'file' in found ? found.file : undefined
}

await test('config.binaryPath is authoritative and is used verbatim', async () => {
  await withTempDir('resolve', async (dir) => {
    const explicit = seed(path.join(dir, 'explicit', executableName()))
    const env = { DSH_HOME: path.join(dir, 'home') }
    seed(managedBinaryFile({ env }))
    const resolved = resolveBinary({ binaryPath: explicit, packageRoot: dir, env })
    assert.equal(resolved.file, explicit)
    assert.equal(resolved.source, 'config.binaryPath')
  })
})

await test('an unusable config.binaryPath fails instead of falling through', async () => {
  await withTempDir('resolve', async (dir) => {
    const env = { DSH_HOME: path.join(dir, 'home') }
    seed(managedBinaryFile({ env }))
    assert.throws(
      () => resolveBinary({ binaryPath: path.join(dir, 'missing.exe'), packageRoot: dir, env }),
      (error) => error instanceof BinaryNotFoundError && /binaryPath/.test(error.message),
    )
  })
})

await test('the environment override wins over the managed copy', async () => {
  await withTempDir('resolve', async (dir) => {
    const env = { DSH_HOME: path.join(dir, 'home') }
    const managed = seed(managedBinaryFile({ env }))
    const override = seed(path.join(dir, 'override', executableName()))
    const resolved = resolveBinary({ packageRoot: dir, env: { ...env, [BINARY_ENV]: override } })
    assert.equal(resolved.file, override)
    assert.equal(resolved.source, BINARY_ENV)
    assert.notEqual(resolved.file, managed)
  })
})

await test('the managed runtime copy wins over the vendored source build', async () => {
  await withTempDir('resolve', async (dir) => {
    const env = { DSH_HOME: path.join(dir, 'home') }
    const managed = seed(managedBinaryFile({ env }))
    seed(path.join(dir, 'vendor', 'fastctx', 'target', 'release', executableName()))
    const resolved = resolveBinary({ packageRoot: dir, env })
    assert.equal(resolved.file, managed)
    assert.equal(resolved.source, 'managed runtime')
  })
})

await test('the vendored source build is found when nothing is provisioned', async () => {
  await withTempDir('resolve', async (dir) => {
    const built = seed(path.join(dir, 'vendor', 'fastctx', 'target', 'release', executableName()))
    const resolved = resolveBinary({ packageRoot: dir, env: { DSH_HOME: path.join(dir, 'home') } })
    assert.equal(resolved.file, built)
    assert.equal(resolved.source, 'vendored source build')
  })
})

await test('PATH lookup finds only absolute PATH entries, and reports absences', async () => {
  await withTempDir('resolve', async (dir) => {
    const binDir = path.join(dir, 'bin')
    seed(path.join(binDir, executableName()))
    // The relative `.` entry is present deliberately: a relative PATH entry
    // would let a planted executable decide the runtime.
    const found = pathBinary({ env: { PATH: ['.', binDir].join(path.delimiter) } })
    assert.equal(path.resolve(found.file), path.resolve(path.join(binDir, executableName())))

    const relativeOnly = pathBinary({ env: { PATH: '.'.concat(path.delimiter, '') } })
    assert.equal(relativeOnly.error, 'fastctx is not on PATH')
    assert.equal(pathBinary({ env: { PATH: '' } }).error, 'PATH is empty')
  })
})

await test('the published platform package is preferred over PATH', async () => {
  await withTempDir('resolve', async (dir) => {
    const onPath = seed(path.join(dir, 'bin', FORGED.executable))
    const forged = stageUpstreamPackage(dir)
    const resolved = resolveBinary({
      ...FORGED,
      packageRoot: dir,
      env: { DSH_HOME: path.join(dir, 'home'), PATH: path.join(dir, 'bin') },
    })
    assert.equal(resolved.source, 'published platform package')
    assert.equal(path.resolve(resolved.file), path.resolve(forged))
    assert.notEqual(path.resolve(resolved.file), path.resolve(onPath))
  })
})

await test('a total failure reports every candidate it considered', async () => {
  await withTempDir('resolve', async (dir) => {
    let failure
    try {
      resolveBinary({
        packageRoot: path.join(dir, 'absent'),
        env: { DSH_HOME: path.join(dir, 'home'), PATH: '' },
        platform: 'sunos',
        arch: 'sparc',
      })
    } catch (error) {
      failure = error
    }
    assert.ok(failure instanceof BinaryNotFoundError, 'expected a BinaryNotFoundError')
    const report_ = failure.report()
    assert.match(report_, /managed runtime/)
    assert.match(report_, /vendored source build/)
    assert.match(report_, /published platform package/)
    assert.match(report_, /sunos/)
    assert.match(report_, /PATH/)
  })
})

await test('probeBinary accepts a working executable and rejects a broken one', async () => {
  // The runner's own Node is the working executable: it is present wherever the
  // suite runs, and it answers `--version` exactly as the probe reads it.
  const probe = probeBinary(process.execPath)
  assert.equal(probe.ok, true, probe.detail)
  assert.match(probe.version, /^v?\d+/u)

  // FastCtx's own version string is asserted only where this checkout resolves a
  // runtime at all: the platform packages are a release-time injection, so a
  // clean checkout legitimately has none.
  let resolved
  try {
    resolved = resolveBinary()
  } catch {
    resolved = undefined
  }
  if (resolved !== undefined) {
    const real = probeBinary(resolved.file)
    assert.equal(real.ok, true, `${resolved.source} did not run: ${real.detail}`)
    assert.match(real.version, /fastctx/i)
  }

  await withTempDir('probe', async (dir) => {
    const fake = seed(path.join(dir, executableName('win32')), 'not an executable')
    const broken = probeBinary(fake)
    assert.equal(broken.ok, false)
    assert.equal(typeof broken.detail, 'string')
  })
})

// ---------------------------------------------------------------------------
// The plugin's own FastCtx platform package (phase C), exercised without
// installing one: a forged package under a temporary root.
// ---------------------------------------------------------------------------

await test('opsFastctxPackage is the frozen name constructor the packaging lane imports', () => {
  assert.equal(opsFastctxPackage('win32', 'x64'), '@dsh-ops/fastctx-win32-x64')
  assert.equal(opsFastctxPackage('linux', 'arm64'), '@dsh-ops/fastctx-linux-arm64')
  assert.equal(opsFastctxPackage(), `@dsh-ops/fastctx-${process.platform}-${process.arch}`)
  assert.equal(Object.isFrozen(opsFastctxPackage), true, 'the name is a contract, not a mutable table')
})

await test('a package root with no manifest reports the bundled package as not installed', async () => {
  await withTempDir('own-package-bare', async (dir) => {
    assert.deepEqual(
      opsFastctxPackageBinary({ ...FORGED, packageRoot: dir }),
      { error: `${FORGED.own} is not installed` },
    )
  })
})

await test('the bundled fastctx package outranks the published @fastctx one', async () => {
  await withTempDir('own-package', async (dir) => {
    const upstream = stageUpstreamPackage(dir)
    const ours = stageOwnPackage(dir)
    const resolved = resolveBinary({ ...FORGED, packageRoot: dir, env: { DSH_HOME: path.join(dir, 'home') } })
    assert.equal(resolved.source, 'bundled fastctx package')
    assert.equal(path.resolve(resolved.file), path.resolve(ours))
    assert.notEqual(path.resolve(resolved.file), path.resolve(upstream))
    // The package it won over is genuinely installed in the very same root, and
    // the order is why it was never reached.
    assert.equal(path.resolve(forgedBinary(dir, FORGED.upstream)), path.resolve(upstream))
    assert.deepEqual(
      resolved.tried.map((entry) => entry.source),
      ['managed runtime', 'vendored source build', 'bundled fastctx package'],
    )
  })
})

await test('without the bundled package the search falls through to the published one', async () => {
  await withTempDir('own-package-absent', async (dir) => {
    const upstream = stageUpstreamPackage(dir)
    stageOwnPackage(dir, { installed: false, declared: true })
    const resolved = resolveBinary({ ...FORGED, packageRoot: dir, env: { DSH_HOME: path.join(dir, 'home') } })
    assert.equal(resolved.source, 'published platform package')
    assert.equal(path.resolve(resolved.file), path.resolve(upstream))
    const missed = resolved.tried.find((entry) => entry.source === 'bundled fastctx package')
    assert.equal(missed.file, FORGED.own)
    assert.equal(missed.detail, `${FORGED.own} is declared but not installed`)
  })
})

await test('a bundled package without its executable is reported, then searched past', async () => {
  await withTempDir('own-package-partial', async (dir) => {
    const upstream = stageUpstreamPackage(dir)
    stageOwnPackage(dir, { binary: false })
    const resolved = resolveBinary({ ...FORGED, packageRoot: dir, env: { DSH_HOME: path.join(dir, 'home') } })
    assert.equal(resolved.source, 'published platform package')
    assert.equal(path.resolve(resolved.file), path.resolve(upstream))
    const missed = resolved.tried.find((entry) => entry.source === 'bundled fastctx package')
    assert.equal(missed.detail, `${FORGED.own} is installed without bin/${FORGED.executable}`)
  })
})

await test('the managed copy and the vendored build still outrank both packages', async () => {
  await withTempDir('own-package-order', async (dir) => {
    const env = { DSH_HOME: path.join(dir, 'home') }
    const managed = seed(managedBinaryFile({ env }))
    const built = seed(path.join(dir, 'vendor', 'fastctx', 'target', 'release', FORGED.executable))
    const ours = stageOwnPackage(dir)
    const upstream = stageUpstreamPackage(dir)
    assert.notEqual(ours, undefined, 'the bundled package is installed for this scenario')
    assert.notEqual(upstream, undefined, 'the upstream package is installed for this scenario')

    const fromManaged = resolveBinary({ ...FORGED, packageRoot: dir, env })
    assert.equal(fromManaged.source, 'managed runtime')
    assert.equal(fromManaged.file, managed)

    fs.rmSync(managed)
    const fromBuilt = resolveBinary({ ...FORGED, packageRoot: dir, env })
    assert.equal(fromBuilt.source, 'vendored source build')
    assert.equal(fromBuilt.file, built)
  })
})

await test('config.binaryPath stays authoritative while the bundled package is installed', async () => {
  await withTempDir('own-package-config', async (dir) => {
    stageOwnPackage(dir)
    stageUpstreamPackage(dir)
    const env = { DSH_HOME: path.join(dir, 'home') }
    const explicit = seed(path.join(dir, 'explicit', FORGED.executable))
    const resolved = resolveBinary({ ...FORGED, binaryPath: explicit, packageRoot: dir, env })
    assert.equal(resolved.file, explicit)
    assert.equal(resolved.source, 'config.binaryPath')
    assert.throws(
      () => resolveBinary({ ...FORGED, binaryPath: path.join(dir, 'missing.exe'), packageRoot: dir, env }),
      (error) => error instanceof BinaryNotFoundError && /binaryPath/.test(error.message),
    )
  })
})

await test('the search log puts the bundled package between the build and the prebuild', async () => {
  await withTempDir('own-package-log', async (dir) => {
    let failure
    try {
      resolveBinary({
        packageRoot: path.join(dir, 'absent'),
        env: { DSH_HOME: path.join(dir, 'home'), PATH: '' },
        platform: 'sunos',
        arch: 'sparc',
      })
    } catch (error) {
      failure = error
    }
    assert.ok(failure instanceof BinaryNotFoundError, 'expected a BinaryNotFoundError')
    assert.deepEqual(
      failure.tried.map((entry) => entry.source),
      [
        'managed runtime',
        'vendored source build',
        'bundled fastctx package',
        'published platform package',
        'PATH',
      ],
    )
    assert.match(failure.report(), /@dsh-ops\/fastctx-sunos-sparc/u)
  })
})

report('binary')
