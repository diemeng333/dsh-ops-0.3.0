#!/usr/bin/env node
/** Build distribution stages, never download on installation or execute foreign binaries.
 * Release input layout: <input>/<platform>-<arch>/dsh-ops-worker[.exe].
 * One npm package carries all supported workers; native target selection happens locally.
 */
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { PLATFORMS, PACKAGE_ROOT, workerName } from '../lib/ptc/runtime.js'
const { values, positionals } = parseArgs({ options: { input: {type:'string'}, root: {type:'string'}, platform: {type:'string'} }, allowPositionals:true })
const command = positionals[0] ?? 'check'
const root = path.resolve(values.root ?? PACKAGE_ROOT)
const version = JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8')).version
const targets = values.platform ? [values.platform] : PLATFORMS
if (targets.some(t=>!PLATFORMS.includes(t))) throw Error('Unsupported target')
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex')
for (const target of targets) {
  const name = workerName(target.split('-')[0])
  const directory = path.join(root,'runtime',target), destination = path.join(directory,name)
  if (command === 'stage') {
    const input = path.resolve(values.input ?? path.join(PACKAGE_ROOT,'native','target','release'))
    const source = values.platform ? path.join(input,name) : path.join(input,target,name)
    if (!fs.statSync(source).isFile()) throw Error(`Missing target build: ${source}`)
    fs.mkdirSync(directory,{recursive:true})
    fs.copyFileSync(source,destination)
    if (!target.startsWith('win32-')) fs.chmodSync(destination,0o755)
    fs.writeFileSync(path.join(directory,'provenance.json'),JSON.stringify({version,target,executable:name,sha256:hash(destination),source:'native/Cargo.lock + native/src; original MIT Rust core'},null,2)+'\n')
  } else if (command !== 'check') throw Error('Expected stage or check')
  const receipt = JSON.parse(fs.readFileSync(path.join(directory,'provenance.json'),'utf8'))
  if (receipt.version !== version || receipt.target !== target || receipt.executable !== name || receipt.sha256 !== hash(destination)) throw Error(`Runtime provenance mismatch: ${target}`)
  const bytes = fs.readFileSync(destination)
  // Reject accidental copies of a host binary labeled as a foreign target.
  if (target.startsWith('win32-')) {
    if (bytes.toString('ascii',0,2) !== 'MZ') throw Error(`Not a PE binary: ${target}`)
    const pe = bytes.readUInt32LE(0x3c)
    if (bytes.readUInt32LE(pe) !== 0x4550 || bytes.readUInt16LE(pe+4) !== (target.endsWith('x64') ? 0x8664 : 0xaa64)) throw Error(`Wrong PE architecture: ${target}`)
  }
  if (target.startsWith('linux-')) {
    if (!bytes.subarray(0,4).equals(Buffer.from([0x7f,0x45,0x4c,0x46])) || bytes[4] !== 2 || bytes[5] !== 1
      || bytes.readUInt16LE(18) !== (target.endsWith('x64') ? 62 : 183)) throw Error(`Wrong ELF architecture: ${target}`)
  }
  if (target.startsWith('darwin-')) {
    if (bytes.readUInt32LE(0) !== 0xfeedfacf || bytes.readUInt32LE(4) !== (target.endsWith('x64') ? 0x1000007 : 0x100000c)) throw Error(`Wrong Mach-O architecture: ${target}`)
  }
  if (process.platform !== 'win32' && !target.startsWith('win32-')) fs.chmodSync(destination,0o755)
  console.log(`${target}: ${bytes.length} bytes, sha256 ${receipt.sha256}`)
}
console.log(`Validated ${targets.length} native runtime(s); no install-time scripts or permission changes.`)
