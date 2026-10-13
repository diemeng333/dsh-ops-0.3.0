/**
 * `dsh-ops uninstall`: the runtime this plugin installed outside the profile, and
 * the FastCtx state it does not own. Plus `dsh-ops ladder`, the same CLI read
 * back through its report.
 *
 * The suite runs the real CLI as a child process against a throwaway `DSH_HOME`
 * rather than importing it. `bin/dsh-ops.mjs` is a program whose whole contract
 * is its argv, its output, and its exit code, and it acts on `process.argv` at
 * module scope: importing it would run `main()` inside this suite with the
 * suite's own arguments. A child process also proves the command deletes real
 * files under the home it was handed, instead of a value the suite injected.
 *
 * `--purge-fastctx` is only ever exercised through the directory the CLI itself
 * reports, and only after the suite has proven that directory is inside this
 * suite's own temporary tree: the command resolves FastCtx's `~/.fastctx` from
 * the environment, and a redirect that silently failed would otherwise delete
 * the developer's real FastCtx state.
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { resolveConfig } from '../lib/config.js'
import { renderToolingPolicy } from '../lib/policy.js'
import { resolveShells } from '../lib/shells.js'
import { PACKAGE_ROOT, TEST_HOME, assert, report, test, withTempDir } from './lib/harness.mjs'

/** The CLI under test. */
const CLI = path.join(PACKAGE_ROOT, 'bin', 'dsh-ops.mjs')

/**
 * Run the CLI with one throwaway home and one redirected user home.
 * @param {object} options - run inputs.
 * @param {string} options.home - `DSH_HOME` for the child.
 * @param {string} options.user - the user home the child resolves `~` from.
 * @param {string[]} options.args - arguments after the command name.
 * @param {string} [options.command] - the command to run.
 * @param {NodeJS.ProcessEnv} [options.env] - the whole child environment, when a
 *   case has to control what the shell resolution sees.
 * @returns {{status: number|null, stdout: string, stderr: string}} the run.
 */
function runCli({ home, user, args, command = 'uninstall', env }) {
  const result = spawnSync(process.execPath, [CLI, command, ...args], {
    cwd: PACKAGE_ROOT,
    encoding: 'utf8',
    env: { ...process.env, DSH_HOME: home, HOME: user, USERPROFILE: user, ...env },
  })
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

/**
 * Seed one home with a managed runtime, a sibling directory that must survive,
 * and FastCtx's own state directory.
 * @param {string} home - the `DSH_HOME` to seed.
 * @param {string} user - the user home to seed.
 * @returns {void}
 */
function seed(home, user) {
  fs.mkdirSync(path.join(home, 'dsh-ops', 'bin'), { recursive: true })
  fs.writeFileSync(path.join(home, 'dsh-ops', 'bin', 'fastctx.exe'), 'stub runtime\n')
  fs.writeFileSync(path.join(home, 'dsh-ops', 'runtime.json'), '{}\n')
  fs.mkdirSync(path.join(home, 'other'), { recursive: true })
  fs.writeFileSync(path.join(home, 'other', 'keep.txt'), 'keep\n')
  fs.mkdirSync(path.join(user, '.fastctx', 'jobs'), { recursive: true })
  fs.writeFileSync(path.join(user, '.fastctx', 'config.toml'), 'x = 1\n')
  fs.writeFileSync(path.join(user, '.fastctx', 'jobs', 'job-1.log'), 'output\n')
}

/** The managed runtime directory for one home. */
const managedDir = (home) => path.join(home, 'dsh-ops')

await test('the default report names the managed runtime and deletes nothing', async () => {
  await withTempDir('uninstall-dry', (dir) => {
    const home = path.join(dir, 'home')
    const user = path.join(dir, 'user')
    seed(home, user)

    const run = runCli({ home, user, args: [] })
    assert.equal(run.status, 0, run.stderr)
    assert.ok(run.stdout.includes(managedDir(home)), 'the report names the managed directory')
    assert.match(run.stdout, /runtime\.json/u, 'the report lists the receipt it would remove')
    assert.match(run.stdout, /--yes/u, 'the report says how to delete')
    assert.ok(fs.existsSync(path.join(managedDir(home), 'bin', 'fastctx.exe')), 'the runtime survived')
    assert.ok(fs.existsSync(path.join(managedDir(home), 'runtime.json')), 'the receipt survived')
    assert.ok(fs.existsSync(path.join(user, '.fastctx')), 'FastCtx state survived')
  })
})

await test('--yes removes the managed runtime and nothing beside it', async () => {
  await withTempDir('uninstall-yes', (dir) => {
    const home = path.join(dir, 'home')
    const user = path.join(dir, 'user')
    seed(home, user)

    const run = runCli({ home, user, args: ['--yes'] })
    assert.equal(run.status, 0, run.stderr)
    assert.equal(fs.existsSync(managedDir(home)), false, 'the managed directory is gone')
    assert.ok(fs.existsSync(path.join(home, 'other', 'keep.txt')), 'a sibling directory survived')
    assert.ok(fs.existsSync(path.join(user, '.fastctx')), 'FastCtx state is not owned by this command')
  })
})

await test('--dry-run overrides --yes', async () => {
  await withTempDir('uninstall-dry-run', (dir) => {
    const home = path.join(dir, 'home')
    const user = path.join(dir, 'user')
    seed(home, user)

    const run = runCli({ home, user, args: ['--yes', '--dry-run'] })
    assert.equal(run.status, 0, run.stderr)
    assert.ok(fs.existsSync(managedDir(home)), 'the managed directory survived an explicit dry run')
  })
})

await test('a missing managed runtime is reported, not an error', async () => {
  await withTempDir('uninstall-missing', (dir) => {
    const home = path.join(dir, 'home')
    const user = path.join(dir, 'user')
    fs.mkdirSync(home, { recursive: true })

    const run = runCli({ home, user, args: ['--yes'] })
    assert.equal(run.status, 0, run.stderr)
    assert.match(run.stdout, /nothing to remove/u)
    assert.match(run.stdout, /does not exist/u)
  })
})

await test('FastCtx state is reported and survives until --purge-fastctx', async () => {
  await withTempDir('uninstall-fastctx', (dir) => {
    const home = path.join(dir, 'home')
    const user = path.join(dir, 'user')
    seed(home, user)

    const reportOnly = runCli({ home, user, args: ['--purge-fastctx'] })
    assert.equal(reportOnly.status, 0, reportOnly.stderr)
    const reported = /FastCtx user data \(not owned by this plugin\)[\s\S]*?directory: (.*)/u.exec(reportOnly.stdout)?.[1]?.trim()
    assert.ok(reported !== undefined, `the report names the FastCtx directory:\n${reportOnly.stdout}`)
    assert.ok(
      path.resolve(reported).startsWith(path.resolve(dir)),
      `refusing to purge ${reported}: it is outside this suite's temporary tree`,
    )
    assert.match(reportOnly.stdout, /would remove/u, 'the dry run says what --yes would take')
    assert.ok(fs.existsSync(reported), 'a dry run purged nothing')

    const purged = runCli({ home, user, args: ['--yes', '--purge-fastctx'] })
    assert.equal(purged.status, 0, purged.stderr)
    assert.equal(fs.existsSync(reported), false, 'the reported directory is the one --purge-fastctx removes')
    assert.equal(fs.existsSync(managedDir(home)), false, 'the managed runtime is removed with it')
  })
})

await test('an empty FastCtx directory is not a failure to purge', async () => {
  await withTempDir('uninstall-no-fastctx', (dir) => {
    const home = path.join(dir, 'home')
    const user = path.join(dir, 'user')
    fs.mkdirSync(managedDir(home), { recursive: true })

    const run = runCli({ home, user, args: ['--yes', '--purge-fastctx'] })
    assert.equal(run.status, 0, run.stderr)
    assert.equal(fs.existsSync(managedDir(home)), false, 'an empty managed directory is still removed')
  })
})

await test('the report keeps plugin removal separate from runtime removal', async () => {
  await withTempDir('uninstall-scope', (dir) => {
    const home = path.join(dir, 'home')
    const user = path.join(dir, 'user')
    seed(home, user)

    const run = runCli({ home, user, args: [] })
    assert.equal(run.status, 0, run.stderr)
    assert.match(run.stdout, /not handled by this command/u)
    assert.match(run.stdout, /remove_bundle/u, 'the profile-side tool is named')
    assert.match(run.stdout, /dsh plugin --profile <profile> remove dsh-ops/u, 'the profile-side command is named')
  })
})

await test('an unknown command still exits 2', () => {
  const run = runCli({ home: TEST_HOME, user: TEST_HOME, args: [], command: 'frobnicate' })
  assert.equal(run.status, 2)
  assert.match(run.stderr, /unknown command/u)
})

// ---------------------------------------------------------------------------
// `dsh-ops ladder`: the resolution report and the rungs the prompt renders
// ---------------------------------------------------------------------------

/**
 * Write one `--config` file holding a `dsh-ops` row config.
 * @param {string} dir - the directory to write into.
 * @param {Record<string, unknown>} config - the row config.
 * @returns {string} the file's path.
 */
function writeConfig(dir, config) {
  const file = path.join(dir, 'config.json')
  fs.writeFileSync(file, `${JSON.stringify(config)}\n`)
  return file
}

/**
 * Make one file that exists, so a config path can point at something.
 *
 * Nothing spawns it: `ladder` never probes, which is exactly why a text file is
 * enough to stand in for a runtime here.
 * @param {string} file - the path to create.
 * @param {string} [contents] - the bytes.
 * @returns {string} the created path.
 */
function seedFile(file, contents = 'not an executable\n') {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, contents)
  return file
}

/**
 * The rung headings one human report printed, in order.
 * @param {string} stdout - the report.
 * @returns {{number: number, title: string}[]} the headings.
 */
function printedRungs(stdout) {
  return stdout.split('\n')
    .map((line) => /^\s+- Rung (\d+) — (.+)$/u.exec(line))
    .filter((match) => match !== null)
    .map((match) => ({ number: Number(match[1]), title: match[2] }))
}

/**
 * Assert the numbered rungs of one report are dense, host-last and exactly the
 * headings the renderer emits for the same levels.
 * @param {{levels: {bash: boolean, pwsh: boolean}, rungs: {number: number, title: string}[]}} report_ - the report value.
 * @returns {void}
 */
function assertLadder(report_) {
  const { levels, rungs } = report_
  assert.deepEqual(rungs, [], 'the retired numbered ladder is empty')
  const published = [
    ...(levels.fastctx ? ['glob', 'grep', 'inspect_local_file', 'replace'].map(name => `ops_${name}`) : []),
    ...(levels.bash ? ['ops_bash'] : []),
    ...(levels.pwsh ? ['pwsh'] : []),
  ]
  assert.equal(report_.policy, renderToolingPolicy({ published, extraGuidance: '' }))
  assert.equal(report_.policy.includes('| General commands'), levels.bash)
  assert.equal(report_.policy.includes('bundled PowerShell 7'), false, 'resolution-only CLI must not claim a mounted pwsh overlay')
}

await test('ladder --json has a stable shape and lists exactly the rungs the renderer emits', async () => {
  await withTempDir('ladder-json', (dir) => {
    const home = path.join(dir, 'home')
    const user = path.join(dir, 'user')
    fs.mkdirSync(home, { recursive: true })
    fs.mkdirSync(user, { recursive: true })
    const runtime = seedFile(path.join(dir, 'fastctx-stub'))
    const bash = seedFile(path.join(dir, 'bash-stub'))
    const args = ['--json', '--config', writeConfig(dir, { binaryPath: runtime, bashPath: bash })]

    const run = runCli({ home, user, args, command: 'ladder' })
    assert.equal(run.status, 0, `expected a report, got ${run.status}: ${run.stderr}`)
    const parsed = JSON.parse(run.stdout)

    assert.deepEqual(Object.keys(parsed), ['fastctx', 'shells', 'levels', 'rungs', 'policy'])
    assert.deepEqual(Object.keys(parsed.fastctx), ['resolved', 'executable', 'source', 'error', 'tried'])
    assert.deepEqual(Object.keys(parsed.shells), ['bash', 'pwsh'])
    for (const kind of ['bash', 'pwsh']) {
      assert.deepEqual(Object.keys(parsed.shells[kind]), ['available', 'executable', 'source', 'detail'])
      assert.equal(
        parsed.shells[kind].executable === null,
        parsed.shells[kind].available === false,
        `${kind}: an unavailable rung names no executable`,
      )
      assert.equal(typeof parsed.shells[kind].detail, 'string')
    }
    assert.deepEqual(Object.keys(parsed.levels), ['fastctx', 'run', 'bash', 'pwsh'])

    assert.equal(parsed.fastctx.resolved, true)
    assert.equal(parsed.fastctx.executable, runtime, 'the configured path is reported verbatim')
    assert.equal(parsed.fastctx.source, 'config.binaryPath')
    assert.equal(parsed.fastctx.error, null)
    assert.equal(parsed.levels.fastctx, true)
    assert.equal(parsed.shells.bash.available, true, `the configured bash resolved: ${parsed.shells.bash.detail}`)
    assert.equal(parsed.levels.bash, true)
    assertLadder(parsed)

    // Both output modes describe one report: the human one prints the same rungs.
    const human = runCli({ home, user, args: args.slice(1), command: 'ladder' })
    assert.equal(human.status, 0, human.stderr)
    assert.deepEqual(printedRungs(human.stdout), parsed.rungs)
    assert.ok(human.stdout.includes(runtime), 'the report names the executable')
    assert.equal(human.stdout.includes('MCP handshake'), false, 'ladder never handshakes')
  })
})

await test('a shell the deployment does not have is reported as missing, with the resolver reason', async () => {
  await withTempDir('ladder-missing', (dir) => {
    const home = path.join(dir, 'home')
    const user = path.join(dir, 'user')
    fs.mkdirSync(home, { recursive: true })
    fs.mkdirSync(user, { recursive: true })
    const runtime = seedFile(path.join(dir, 'fastctx-stub'))
    // `allowSystemShellFallback: false` is what makes this case host-independent.
    // A machine with a Git for Windows or an msys64 bash at a well-known location
    // would otherwise resolve one, and each side of the comparison would resolve
    // the one its own environment names — which is exactly what the first CI run
    // of this repository caught. With the host's shells out of play, both sides
    // can only report the rung missing, which is what this case is about.
    const config = { binaryPath: runtime, allowSystemShellFallback: false }
    const absent = path.join(dir, 'absent')
    // The whole environment both sides see, so nothing outside it can decide the
    // answer.
    const env = {
      ...process.env,
      DSH_HOME: home,
      HOME: user,
      USERPROFILE: user,
      PATH: '',
      ProgramFiles: absent,
      'ProgramFiles(x86)': absent,
      LOCALAPPDATA: absent,
    }
    const args = ['--config', writeConfig(dir, config)]

    const human = runCli({ home, user, args, command: 'ladder', env })
    assert.equal(human.status, 0, human.stderr)
    const machine = runCli({ home, user, args: ['--json', ...args], command: 'ladder', env })
    const parsed = JSON.parse(machine.stdout)

    const resolved = resolveShells(resolveConfig(config), { env })
    for (const kind of ['bash', 'pwsh']) {
      assert.deepEqual(parsed.shells[kind], {
        available: resolved[kind].available,
        executable: resolved[kind].file ?? null,
        source: resolved[kind].source,
        detail: resolved[kind].detail,
      }, `the report and the resolver disagree about ${kind}`)
      if (resolved[kind].source === 'missing') {
        assert.equal(parsed.shells[kind].executable, null)
        assert.match(human.stdout, /executable: missing/u)
        assert.ok(
          human.stdout.includes(resolved[kind].detail),
          `the missing ${kind} rung reports why: ${human.stdout}`,
        )
      }
    }
    assert.equal(parsed.levels.bash, resolved.bash.available, 'bundled payloads remain available even with an empty system PATH')
    assertLadder(parsed)
  })
})

await test('a rung that is off leaves no ops_bash heading and no numbered gap', async () => {
  await withTempDir('ladder-off', (dir) => {
    const home = path.join(dir, 'home')
    const user = path.join(dir, 'user')
    fs.mkdirSync(home, { recursive: true })
    const runtime = seedFile(path.join(dir, 'fastctx-stub'))
    const args = ['--json', '--config', writeConfig(dir, { binaryPath: runtime, publishBashTool: false })]

    const run = runCli({ home, user, args, command: 'ladder' })
    assert.equal(run.status, 0, run.stderr)
    const parsed = JSON.parse(run.stdout)

    assert.equal(parsed.levels.fastctx, true)
    assert.equal(parsed.levels.bash, false)
    assert.equal(parsed.shells.bash.available, false)
    assert.equal(parsed.shells.bash.source, 'disabled')
    assert.match(parsed.shells.bash.detail, /publishBashTool is false/u)
    assert.equal(parsed.rungs.some((rung) => rung.title.includes('ops_bash')), false)
    assertLadder(parsed)
  })
})

await test('ladder fails loud on a config the plugin would refuse', async () => {
  await withTempDir('ladder-config', (dir) => {
    const home = path.join(dir, 'home')
    const user = path.join(dir, 'user')
    fs.mkdirSync(home, { recursive: true })
    const unknown = runCli({
      home,
      user,
      command: 'ladder',
      args: ['--config', writeConfig(dir, { pwshPath: 'C:\\pwsh.exe' })],
    })
    assert.equal(unknown.status, 1)
    assert.match(unknown.stderr, /unknown key/u)
    assert.match(unknown.stderr, /pwshPath/u)

    const broken = path.join(dir, 'broken.json')
    fs.writeFileSync(broken, '{ not json\n')
    const unparsable = runCli({ home, user, command: 'ladder', args: ['--config', broken] })
    assert.equal(unparsable.status, 1)
    assert.match(unparsable.stderr, /one JSON object/u)

    const absent = runCli({ home, user, command: 'ladder', args: ['--config', path.join(dir, 'absent.json')] })
    assert.equal(absent.status, 1)
    assert.match(absent.stderr, /readable file/u)
  })
})

// ---------------------------------------------------------------------------
// `dsh-ops provision-shells`: the pinned upstream copies, with no download
// ---------------------------------------------------------------------------

/** Windows' own bsdtar: it writes and reads the zip shape the pwsh pin names. */
const BSDTAR = path.join(process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows', 'System32', 'tar.exe')

/**
 * Whether this host can exercise the pin table at all.
 *
 * The pins cover `win32-x64`, and the command looks its pin up by the running
 * platform, so a host the table does not cover cannot reach the code under test.
 * It says so instead of passing quietly.
 * @param {string} name - the check name.
 * @returns {boolean} whether to skip.
 */
function skipUnpinnedHost(name) {
  if (process.platform === 'win32' && process.arch === 'x64') return false
  console.log(`  skip ${name} — the pin table covers win32-x64, this host is ${process.platform}-${process.arch}`)
  return true
}

/**
 * The SHA-256 of one file.
 * @param {string} file - the file to hash.
 * @returns {string} the lowercase hex digest.
 */
function sha256Of(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

/**
 * Write one `--pin` file holding a single forged pin for this host.
 * @param {string} dir - the directory to write into.
 * @param {Record<string, unknown>} pin - the pin's fields.
 * @returns {string} the file's path.
 */
function writePin(dir, pin) {
  const file = path.join(dir, 'pin.json')
  fs.writeFileSync(file, `${JSON.stringify([pin])}\n`)
  return file
}

/**
 * A pin whose URL is unreachable, so a run that reached for the network would
 * fail or hang: a passing run proves it did not.
 * @param {Record<string, unknown>} overrides - the pin's fields.
 * @returns {Record<string, unknown>} the pin.
 */
function unreachablePin(overrides) {
  return {
    name: 'pwsh',
    label: 'forged',
    platform: 'win32',
    arch: 'x64',
    upstreamRepo: 'https://example.invalid/pwsh',
    releaseTag: 'v0.0.1',
    version: '0.0.1',
    assetFile: 'forged-pwsh.zip',
    url: 'https://127.0.0.1:9/forged-pwsh.zip',
    sha256: 'a'.repeat(64),
    bytes: 1234,
    license: 'MIT',
    extractor: 'zip',
    extractTo: 'bin',
    executableRelativePath: 'bin/pwsh.exe',
    ...overrides,
  }
}

await test('provision-shells --dry-run downloads nothing and writes nothing', async () => {
  if (skipUnpinnedHost('provision-shells --dry-run downloads nothing and writes nothing')) return
  await withTempDir('provision-dry', (dir) => {
    const home = path.join(dir, 'home')
    const user = path.join(dir, 'user')
    fs.mkdirSync(home, { recursive: true })
    const pin = unreachablePin({})
    const run = runCli({
      home,
      user,
      command: 'provision-shells',
      args: ['--pwsh', '--dry-run', '--pin', writePin(dir, pin)],
    })
    assert.equal(run.status, 0, run.stderr)
    assert.match(run.stdout, /would provision version 0\.0\.1/u)
    assert.match(run.stdout, /dry run/u)
    assert.ok(run.stdout.includes(pin.url), 'the report names the URL it would fetch')
    assert.ok(run.stdout.includes(pin.sha256), 'the report names the digest it would check')
    assert.match(run.stdout, /\(1\.2 kB\)/u, 'the report names the size it would download')
    assert.match(run.stdout, new RegExp(home.replace(/\\/g, '\\\\'), 'u'), 'the report names the store it would write')
    // Neither the store nor a scratch download exists: a dry run is a report.
    assert.equal(fs.existsSync(path.join(home, 'dsh-ops')), false)
    assert.deepEqual(fs.readdirSync(home), [])
  })
})

await test('provision-shells refuses bytes that do not match the pin, and keeps them', async () => {
  if (skipUnpinnedHost('provision-shells refuses bytes that do not match the pin, and keeps them')) return
  await withTempDir('provision-hash', (dir) => {
    const home = path.join(dir, 'home')
    const user = path.join(dir, 'user')
    fs.mkdirSync(home, { recursive: true })
    const asset = seedFile(path.join(dir, 'assets', 'forged-pwsh.zip'), 'these are not the pinned bytes\n')
    const pin = unreachablePin({
      url: new URL(`file:///${asset.replace(/\\/g, '/')}`).href,
      sha256: 'b'.repeat(64),
    })
    const run = runCli({
      home,
      user,
      command: 'provision-shells',
      args: ['--pwsh', '--pin', writePin(dir, pin)],
    })
    assert.equal(run.status, 1)
    assert.ok(run.stderr.includes('b'.repeat(64)), 'the expected digest is reported')
    assert.ok(run.stderr.includes(sha256Of(asset)), 'the actual digest is reported')
    assert.match(run.stderr, /refusing to install/u)
    // The bytes are kept where the report says they are: "the digest did not
    // match" is only actionable with the file in hand.
    const kept = /kept for diagnosis: (.+)$/mu.exec(run.stderr)?.[1]?.trim()
    assert.ok(kept !== undefined, `the report names the kept file:\n${run.stderr}`)
    assert.equal(fs.existsSync(kept), true, `the kept file is really there: ${kept}`)
    assert.equal(sha256Of(kept), sha256Of(asset), 'the kept file is the downloaded one')
    assert.equal(fs.existsSync(path.join(home, 'dsh-ops', 'shells', 'pwsh', '0.0.1')), false, 'nothing was installed')
  })
})

await test('provision-shells installs a pinned zip, prunes the old version, and then skips itself', async () => {
  const name = 'provision-shells installs a pinned zip, prunes the old version, and then skips itself'
  if (skipUnpinnedHost(name)) return
  if (!fs.existsSync(BSDTAR)) {
    console.log(`  skip ${name} — no bsdtar at %SystemRoot%\\System32\\tar.exe to build the fixture`)
    return
  }
  await withTempDir('provision-install', (dir) => {
    const home = path.join(dir, 'home')
    const user = path.join(dir, 'user')
    fs.mkdirSync(home, { recursive: true })

    // The fixture has the real shape of the pwsh asset: a zip holding the
    // executable at its root, which the pin unpacks into `bin/`.
    const staged = path.join(dir, 'staged')
    seedFile(path.join(staged, 'pwsh.exe'), 'forged pwsh 0.0.1\n')
    const asset = path.join(dir, 'assets', 'forged-pwsh.zip')
    fs.mkdirSync(path.dirname(asset), { recursive: true })
    const zipped = spawnSync(BSDTAR, ['-a', '-cf', asset, '-C', staged, '.'], { encoding: 'utf8' })
    assert.equal(zipped.status, 0, `bsdtar could not build the fixture: ${zipped.stderr}`)

    const pin = unreachablePin({
      url: new URL(`file:///${asset.replace(/\\/g, '/')}`).href,
      sha256: sha256Of(asset),
      executableSha256: sha256Of(path.join(staged, 'pwsh.exe')),
      bytes: fs.statSync(asset).size,
    })
    const pinFile = writePin(dir, pin)
    const store = path.join(home, 'dsh-ops', 'shells', 'pwsh')

    // A version the pin no longer names sits in the store: the install replaces
    // it, because the resolution would still consider it.
    seedFile(path.join(store, '0.0.0', 'bin', 'pwsh.exe'), 'an older copy\n')

    const installed = runCli({ home, user, command: 'provision-shells', args: ['--pwsh', '--pin', pinFile] })
    assert.equal(installed.status, 0, installed.stderr)
    const executable = path.join(store, '0.0.1', 'bin', 'pwsh.exe')
    assert.equal(fs.existsSync(executable), true, `the executable landed where the resolver looks:\n${installed.stdout}`)
    assert.equal(sha256Of(executable), sha256Of(path.join(staged, 'pwsh.exe')))
    const receipt = JSON.parse(fs.readFileSync(path.join(store, '0.0.1', '.provisioned.json'), 'utf8'))
    assert.equal(receipt.sha256, pin.sha256)
    assert.equal(receipt.url, pin.url)
    assert.equal(receipt.version, '0.0.1')
    assert.equal(fs.existsSync(path.join(store, '0.0.0')), false, 'the version the pin no longer names is gone')

    // Second run: the asset the pin names is gone, so a run that went looking
    // for it would fail. It reports the copy as current instead.
    fs.rmSync(asset)
    const again = runCli({ home, user, command: 'provision-shells', args: ['--pwsh', '--pin', pinFile] })
    assert.equal(again.status, 0, again.stderr)
    assert.match(again.stdout, /already provisioned/u)
    assert.ok(again.stdout.includes(executable), 'the report names the copy it kept')

    // --force reinstalls, which is what proves the skip above really skipped the
    // missing asset rather than reporting success for some other reason.
    const forced = runCli({ home, user, command: 'provision-shells', args: ['--pwsh', '--force', '--pin', pinFile] })
    assert.equal(forced.status, 1)
    assert.match(forced.stderr, /curl exited with code/u)
  })
})

await test('ladder reports the provisioned pwsh rung the store feeds', async () => {
  if (skipUnpinnedHost('ladder reports the provisioned pwsh rung the store feeds')) return
  await withTempDir('provision-ladder', (dir) => {
    const home = path.join(dir, 'home')
    const user = path.join(dir, 'user')
    fs.mkdirSync(home, { recursive: true })
    const executable = seedFile(path.join(home, 'dsh-ops', 'shells', 'pwsh', '7.6.6', 'bin', 'pwsh.exe'))
    const runtime = seedFile(path.join(dir, 'fastctx-stub'))
    const run = runCli({
      home,
      user,
      command: 'ladder',
      args: ['--json', '--config', writeConfig(dir, { binaryPath: runtime })],
    })
    assert.equal(run.status, 0, run.stderr)
    const parsed = JSON.parse(run.stdout)
    assert.deepEqual(parsed.shells.pwsh, {
      available: true,
      executable,
      source: 'provisioned',
      detail: 'the PowerShell 7 this deployment provisioned from upstream (version 7.6.6), '
        + 'which the pwsh-sandbox override points at',
    })
    assert.equal(parsed.levels.pwsh, true)
  })
})

await test('provision-shells fails loud on a pin it cannot honour', async () => {
  if (skipUnpinnedHost('provision-shells fails loud on a pin it cannot honour')) return
  await withTempDir('provision-pin', (dir) => {
    const home = path.join(dir, 'home')
    const user = path.join(dir, 'user')
    fs.mkdirSync(home, { recursive: true })

    const malformed = runCli({
      home,
      user,
      command: 'provision-shells',
      args: ['--pwsh', '--pin', writePin(dir, unreachablePin({ extractTo: '../outside' }))],
    })
    assert.equal(malformed.status, 1)
    assert.match(malformed.stderr, /pins\[0\]\.extractTo/u)

    const wrongDigest = runCli({
      home,
      user,
      command: 'provision-shells',
      args: ['--pwsh', '--pin', writePin(dir, unreachablePin({ sha256: 'not-a-digest' }))],
    })
    assert.equal(wrongDigest.status, 1)
    assert.match(wrongDigest.stderr, /pins\[0\]\.sha256/u)

    const notJson = path.join(dir, 'not-json.json')
    fs.writeFileSync(notJson, '{ oops\n')
    const unparsable = runCli({ home, user, command: 'provision-shells', args: ['--pwsh', '--pin', notJson] })
    assert.equal(unparsable.status, 1)
    assert.match(unparsable.stderr, /one JSON document of pins/u)

    const absent = runCli({ home, user, command: 'provision-shells', args: ['--pwsh', '--pin', path.join(dir, 'absent.json')] })
    assert.equal(absent.status, 1)
    assert.match(absent.stderr, /readable file/u)

    // A pinned platform the running host is not: the command names what it does
    // cover instead of guessing.
    const otherPlatform = runCli({
      home,
      user,
      command: 'provision-shells',
      args: ['--pwsh', '--pin', writePin(dir, unreachablePin({ arch: 'arm64' }))],
    })
    assert.equal(otherPlatform.status, 1)
    assert.match(otherPlatform.stderr, /no upstream pin for pwsh on win32-x64/u)
    assert.match(otherPlatform.stderr, /pin table covers win32-arm64/u)
  })
})

report('bin')
