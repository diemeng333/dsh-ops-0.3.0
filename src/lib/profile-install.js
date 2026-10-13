/** Profile operations delegate to the official CLI instead of reimplementing its locks and rollback. */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { PACKAGE_ROOT, dshHome } from './binary.js'

export function profileCommand(operation, { profile, dshCli, dryRun = false }) {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Only Windows x64 is supported.')
  const aliases = { desktop: 'desktop', web: 'web', tui: 'dsh-tui', 'dsh-tui': 'dsh-tui' }
  if (!Object.hasOwn(aliases, profile ?? '')) throw new Error('Explicit --profile desktop|web|tui is required (tui maps to dsh-tui).')
  const target = aliases[profile]
  const directory = path.join(dshHome(), 'profiles', target)
  if (!fs.existsSync(path.join(directory, 'package.json'))) throw new Error(`Initialize the target DSH application/profile first: ${directory}`)
  const version = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8')).version
  if (operation === 'status') {
    const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'))
    console.log(JSON.stringify({ profile: target, directory, dependency: manifest.dependencies?.['dsh-ops'] ?? null, enabled: (manifest.dsh?.profile?.bundles ?? []).includes('dsh-ops') }, null, 2))
    return 0
  }
  const args = ['plugin', '--profile', target, operation === 'install' ? 'add' : 'remove', operation === 'install' ? `dsh-ops@${version}` : 'dsh-ops']
  let command = dshCli ?? process.env.DSH_OPS_DSH_CLI
  let prefix = []
  if (!command && target === 'desktop') {
    const local = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData/Local')
    command = [path.join(local, 'Programs/DeepSeek Harness/resources/runtime/cli/bin/dsh.cmd')].find(file => fs.existsSync(file))
    if (!command) throw new Error('Desktop requires its own CLI. Pass --dsh-cli <installation>/resources/runtime/cli/bin/dsh.cmd; ordinary dsh cannot manage desktop.')
  }
  if (!command) {
    const globalNpm = process.env.APPDATA ? path.join(process.env.APPDATA, 'npm/node_modules/_anchor.json') : undefined
    for (const anchor of [path.join(directory, 'package.json'), path.join(dshHome(), 'package.json'), globalNpm].filter(Boolean)) {
      try {
        const require = createRequire(anchor)
        const file = require.resolve('@deepseek-ai/dsh/package.json')
        const manifest = JSON.parse(fs.readFileSync(file, 'utf8'))
        const bin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.dsh
        if (bin) { command = process.execPath; prefix = [path.resolve(path.dirname(file), bin)]; break }
      } catch {}
    }
    if (!command) {
      const desktopCli = path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData/Local'), 'Programs/DeepSeek Harness/resources/runtime/cli/bin/dsh.cmd')
      command = fs.existsSync(desktopCli) ? desktopCli : 'dsh.cmd'
    }
  }
  console.log(`Target: ${target} (${directory})`)
  console.log(`Official CLI: ${command}; ${args.join(' ')}`)
  if (dryRun) return 0
  let result
  if (/\.cmd$/i.test(command)) {
    // cmd wrappers are Windows-owned launchers; reject shell metacharacters in caller-supplied paths.
    if (/["\r\n&|<>^%!]/.test(command)) throw new Error('Unsafe CLI path; use a path without cmd metacharacters.')
    result = spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `""${command}" ${args.join(' ')}"`], { stdio: 'inherit', windowsHide: true, windowsVerbatimArguments: true })
  } else result = spawnSync(command, [...prefix, ...args], { stdio: 'inherit', windowsHide: true })
  if (result.error) throw result.error
  if (result.status !== 0) return result.status ?? 1
  console.log(operation === 'install'
    ? 'Installed through the official profile manager. Reload/restart the target application if needed. Binaries are profile dependencies; no postinstall downloads.'
    : 'Removed through the official profile manager, including its runtime dependency references. Package-manager shared caches are not deleted.')
  return 0
}
