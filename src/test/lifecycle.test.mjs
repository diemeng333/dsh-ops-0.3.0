/** Ownership tests: shared runtime-host is not a child to kill. */
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { McpStdioClient } from '../lib/handshake.js'
import { acquireRuntime } from '../lib/runtime-pool.js'
import { resolveRuntime, tryResolveRuntime } from './lib/host.mjs'
import { assert, PACKAGE_ROOT, report, skipSuite, test, waitFor, withTempDir } from './lib/harness.mjs'
const runtime = tryResolveRuntime()
if (!runtime.ok) {
  if (process.env.DSH_OPS_REQUIRE_RUNTIME === '1') throw new Error(runtime.reason)
  skipSuite('lifecycle', runtime.reason)
}
function alive(pid) { try { process.kill(pid, 0); return true } catch (error) { if (error.code === 'ESRCH') return false; throw error } }
function exitOf(child) { return new Promise(resolve => { child.once('exit', resolve); child.once('error', resolve) }) }
function env() { return { ...process.env, FASTCTX_NO_PARENT_WATCH: '1' } }
await test('close rejects pending calls immediately and concurrent closes await the same exit', async () => {
  const before = process.listenerCount('exit')
  const client = McpStdioClient.start({ file: process.execPath, args: ['-e', 'process.stdin.resume(); setInterval(()=>{},1000)'], timeoutMs: 30000 })
  const pending = client.request('never-answers').catch(error => error)
  const a = client.close(), b = client.close()
  assert.equal(a, b)
  assert.match((await pending).message, /closing/)
  await a
  assert.equal(alive(client.child.pid), false)
  assert.equal(process.listenerCount('exit'), before)
})
await test('reply EOF closes an otherwise live child rather than leaving a connected process', async () => {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), signals: [] })
  child.kill = signal => { child.signals.push(signal); setImmediate(() => child.emit('exit', 0, signal)); return true }
  const client = new McpStdioClient(child, 5000)
  child.stdout.end()
  await client.exited
  assert.equal(child.signals.length, 1)
  assert.equal(client.closed, true)
})
await test('the released serve binary exits on stdin EOF without killing a shared runtime-host', async () => {
  const client = McpStdioClient.start({ file: runtime.file, args: ['serve', '--enable-shell'] })
  try {
    await client.initialize(); await client.listTools()
    client.child.stdin.end()
    await waitFor(() => client.exitInfo !== undefined, { timeoutMs: 6000, what: 'serve stdin EOF' })
    assert.equal(alive(client.child.pid), false)
  } finally { await client.close() }
})
await test('spawn forces identity-aware owner watch without mutating the caller environment', async () => {
  const supplied = { ...process.env, FASTCTX_NO_PARENT_WATCH: '1' }
  const program = `process.stdin.setEncoding('utf8'); process.stdin.on('data', data => { const msg = JSON.parse(data.trim()); if(msg.id) console.log(JSON.stringify({id:msg.id,result:{watch:process.env.FASTCTX_NO_PARENT_WATCH}})) });`
  const client = McpStdioClient.start({ file: process.execPath, args: ['-e', program], env: supplied })
  try {
    assert.equal((await client.request('probe')).watch, '0')
    assert.equal(supplied.FASTCTX_NO_PARENT_WATCH, '1')
  } finally { await client.close() }
})
await test('shared file/background leases keep the client until the final release', async () => {
  const ctx = { root: {} }
  const first = await acquireRuntime(ctx, resolveRuntime(), env())
  const second = await acquireRuntime(ctx, resolveRuntime(), env())
  try {
    assert.equal(first.client, second.client)
    const pid = first.client.child.pid
    await first.release()
    assert.equal(alive(pid), true)
    assert.ok((await second.client.listTools()).length >= 4)
    await second.release()
    assert.equal(alive(pid), false)
    await second.release()
  } finally { await first.release(); await second.release() }
})
await test('repeated short-lived client owners leave no serve child on explicit process.exit', async () => {
  await ownerExit('normal', 3)
})
await test('a force-killed owner leaves no serve child even with inherited no-parent-watch enabled', async () => {
  await ownerExit('forced', 2)
})
async function ownerExit(mode, count) {
  await withTempDir(`owner-${mode}`, async dir => {
    // Use the released binary and a fake home. No shared real runtime-host is
    // enumerated or terminated; only known fixture process identities are used.
    const script = path.join(dir, 'owner.mjs')
    const module = pathToFileURL(path.join(PACKAGE_ROOT, 'lib/handshake.js')).href
    fs.writeFileSync(script, `import { McpStdioClient } from ${JSON.stringify(module)};\n` +
      `const client = McpStdioClient.start({ file: ${JSON.stringify(runtime.file)}, args: ['serve','--enable-shell'], env: { ...process.env, FASTCTX_NO_PARENT_WATCH: '1' } });\n` +
      `await client.initialize(); await client.listTools(); process.send({ pid: client.child.pid });\n` +
      `process.on('message', () => process.exit(0)); setInterval(()=>{},1000);\n`)
    for (let i = 0; i < count; i++) {
      const owner = spawn(process.execPath, [script], { env: { ...process.env, HOME: dir, USERPROFILE: dir }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true })
      const done = exitOf(owner)
      let pid
      try {
        const message = await Promise.race([
          new Promise((resolve, reject) => { owner.once('message', resolve); owner.once('error', reject); owner.once('exit', code => reject(new Error(`owner exited early ${code}`))) }),
          new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('owner startup timed out')), 15000); timer.unref() }),
        ])
        pid = message.pid
        assert.equal(alive(pid), true)
        if (mode === 'forced') owner.kill('SIGKILL')
        else owner.send('exit')
        await done
        await waitFor(() => !alive(pid), { timeoutMs: 6000, what: `${mode} owner child ${pid} to exit` })
      } finally {
        if (owner.exitCode === null && owner.signalCode === null) owner.kill('SIGKILL')
        await done
        // On test failure clean only the exact owned child, never a name sweep.
        if (pid && alive(pid)) process.kill(pid, 'SIGKILL')
      }
    }
  })
}
report('lifecycle')
