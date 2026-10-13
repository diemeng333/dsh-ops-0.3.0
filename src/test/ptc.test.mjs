/** Three end-to-end scenarios: real Rust worker + real Cordis/tools/prompt;
 * simulated workspace and confinement provider, no business code in tests.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync, spawn } from 'node:child_process'
import { Context } from '@deepseek-ai/cordis'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { createScope } from '@deepseek-ai/dsh-scope'
import * as ptc from '../lib/ptc/index.js'
import { definition } from '../lib/ptc/contract.js'
import { resolveWorker } from '../lib/ptc/runtime.js'
import Sandbox from '@deepseek-ai/dsh-sandbox-local'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import { invoke } from '../lib/ptc/worker.js'
const file = process.env.DSH_OPS_WORKER_BIN ?? path.resolve('native/target/release', process.platform === 'win32' ? 'dsh-ops-worker.exe' : 'dsh-ops-worker')
assert.ok(fs.existsSync(file), 'Build the independent worker with npm run build:ptc; this suite never silently skips.')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-ptc-'))
const request = (tool, args, scope = 'scenario') => {
  const result = spawnSync(file, [], { input: JSON.stringify({ root: dir, scope, tool, args }), encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  return JSON.parse(result.stdout)
}
const write = (name, text = name) => { fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true }); fs.writeFileSync(path.join(dir, name), text) }
const exists = name => fs.existsSync(path.join(dir, name))
try {
  // 1. Mixed cleanup: preserved main, junction, readonly Git file, collision,
  // observation conflict and restart/resume without repeating completed items.
  write('main/keep', 'protected'); write('review/.git/objects/ro', 'readonly');
  fs.chmodSync(path.join(dir, 'review/.git/objects/ro'), 0o444)
  fs.symlinkSync(path.join(dir, 'main'), path.join(dir, 'review/link'), process.platform === 'win32' ? 'junction' : 'dir')
  write('source/a', 'alpha'); write('source/b', 'beta')
  const run = request('batch', { action: 'run', protect: ['main'], operations: [
    { op: 'remove', path: 'review' }, { op: 'copy', path: 'source/a', to: 'copy-a' }, { op: 'move', path: 'source/b', to: 'moved-b' },
  ] })
  assert.equal(run.status, 'completed', JSON.stringify(run)); assert.equal(run.done, 3)
  assert.equal(exists('review'), false); assert.equal(exists('source/b'), false); assert.equal(exists('main/keep'), true)
  assert.equal(fs.readFileSync(path.join(dir, 'copy-a'), 'utf8'), 'alpha')
  write('source/a', 'new content')
  assert.equal(request('batch', { action: 'resume', id: run.id }).done, 3)
  assert.equal(fs.readFileSync(path.join(dir, 'copy-a'), 'utf8'), 'alpha', 'completed copy never re-executed')
  assert.equal(request('batch', { action: 'run', operations: [{ op: 'copy', path: 'source/a', to: 'copy-a' }] }).error.code, 'REVISION_CONFLICT')
  assert.equal(request('batch', { action: 'run', protect: ['main'], operations: [{ op: 'remove', path: 'main' }] }).error.code, 'POLICY_DENIED')
  assert.equal(request('batch', { action: 'run', operations: [{ op: 'move', path: 'source', to: 'source/nested' }] }).error.code, 'POLICY_DENIED')
  const plan = request('batch', { action: 'plan', operations: [{ op: 'remove', path: 'source/a' }] })
  assert.equal(request('batch', { action: 'run', id: plan.id }).error.code, 'INVALID_ARGUMENT')
  write('source/a', 'changed after observation')
  assert.equal(request('batch', { action: 'resume', id: plan.id }).failed, 1); assert.ok(exists('source/a'))
  const page = request('result', { action: 'page', id: run.id })
  assert.equal(page.items.length, 3); assert.equal(page.complete, true)
  assert.equal(request('result', { action: 'page', id: run.id }, 'foreign-session').error.code, 'POLICY_DENIED')
  // Simulate the durable write-ahead boundary left by a process crash, rather than
  // adding fault-injection switches to production code.
  const store = path.join(dir, '.dsh-ops')
  const latest = fs.readdirSync(store).filter(n => n.startsWith(`${run.id}.`) && n.endsWith('.json')).sort().at(-1)
  const manifest = JSON.parse(fs.readFileSync(path.join(store, latest), 'utf8'))
  manifest.items[0].state = 'unknown'; manifest.items[1].state = 'unknown'; write('copy-a', 'partial copy')
  const generation = Number(latest.split('.')[1])+1
  fs.writeFileSync(path.join(store, `${run.id}.${String(generation).padStart(6,'0')}.json`), JSON.stringify(manifest))
  const recovered = request('batch', { action: 'resume', id: run.id })
  assert.equal(recovered.done, 2); assert.equal(recovered.unknown, 1)
  assert.equal(fs.readFileSync(path.join(dir, 'copy-a'), 'utf8'), 'partial copy', 'unknown mismatch is not retried')
  console.log('ok: mixed workspace preflight, no-follow, readonly cleanup and conservative recovery')

  // 2. Large result data stays local, lossless paged rows and bounded projection.
  const rows = Array.from({ length: 1000 }, (_, n) => ({ n, kind: n%2 ? 'odd' : 'even', payload: 'x'.repeat(160) }))
  const reference = request('result', { action: 'put', items: rows })
  const got = []; let offset = 0
  do {
    const page = request('result', { action: 'page', id: reference.id, offset, limit: 512, maxBytes: 2048 })
    assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 2048); got.push(...page.items); offset = page.nextOffset
    if (page.complete) break
    assert.ok(page.items.length)
  } while (offset < rows.length)
  assert.deepEqual(got, rows)
  const projected = request('result', { action: 'page', id: reference.id, equals: { kind: 'even' }, fields: ['n'], limit: 512, maxBytes: 16384 })
  assert.equal(projected.total, 500); assert.deepEqual(projected.items[1], { n: 2 })
  assert.equal(request('result', { action: 'put', items: [{ huge: 'x'.repeat(2000) }] }).total, 1)
  assert.equal(request('result', { action: 'page', id: reference.id, maxBytes: 1 }).error.code, 'INVALID_ARGUMENT')
  assert.equal(request('result', { action: 'release', id: reference.id }).status, 'released')
  assert.equal(request('result', { action: 'page', id: reference.id }).error.code, 'NOT_FOUND')
  write('reference-source', 'stored operation')
  const operationRef = request('result', { action: 'put', items: [{ op: 'copy', path: 'reference-source', to: 'reference-dest' }] })
  assert.equal(request('batch', { action: 'run', operationsRef: operationRef.id }).status, 'completed')
  const huge = request('result', { action: 'put', items: [{ payload: 'x'.repeat(2000) }] })
  assert.equal(request('result', { action: 'page', id: huge.id, maxBytes: 512 }).error.code, 'OUTPUT_LIMIT')
  assert.equal(request('result', { action: 'page', id: huge.id, fields: ['payload'], maxBytes: 4096 }).items[0].payload.length, 2000)
  const schemaBytes = Buffer.byteLength(JSON.stringify(['batch','result'].map(n => definition(n, () => {})).map(({name,description,parameters}) => ({name,description,parameters}))))
  console.log(`ok: 1000-row round trip and byte-bounded projection; schemas=${schemaBytes} bytes, summary=${Buffer.byteLength(JSON.stringify(run))} bytes vs audit=${Buffer.byteLength(JSON.stringify(page))} bytes`)

  // 3. Actual host registration scopes and presentation with a simulated enforcing
  // provider; subprocess still starts the real worker. Never claim this is an OS sandbox test.
  const ctx = new Context(); ctx.logger.level = 0
  const calls = []; const handles = new Set()
  const subprocess = { spawn(spec) {
    calls.push(spec)
    let out = '', err = ''
    const child = spawn(spec.argv[0], spec.argv.slice(1), { cwd: spec.cwd, stdio: 'pipe' }); handles.add(child)
    child.stdout.on('data', b => out += b); child.stderr.on('data', b => err += b)
    child.stdin.end(spec.stdio.stdin.data)
    const abort = () => child.kill(); spec.signal?.addEventListener('abort', abort, { once: true })
    return { collected: { stdout: { readFrom: () => ({text:out,lossy:false}) }, stderr: { readFrom: () => ({text:err,lossy:false}) } },
      done: new Promise((resolve,reject) => { child.on('error',reject); child.on('close',(exitCode,signal) => {
        handles.delete(child); spec.signal?.removeEventListener('abort',abort); resolve({exitCode,signal})
      }) }) }
  } }
  try {
    await ctx.plugin(SystemPrompt, {}); await ctx.plugin(ToolRuntime, { mode: 'native' })
    let sandboxAvailable = true
    await ctx.plugin(inner => {
      inner.provide('ptcRuntime', { language: 'typescript' })
      inner.provide('subprocess', subprocess)
      inner.provide('sandboxPolicy', { resolve: ({session}) => ({ mode: session.mode, workspaceRoot: dir, sessionId: session.id }) })
      inner.provide('sandbox', { async confine(argv, policy) {
        assert.equal(policy.mode, 'workspace-write')
        if (!sandboxAvailable) throw Object.assign(new Error('fixture backend unavailable'), { code: 'SANDBOX_UNAVAILABLE' })
        return { argv, enforcement: 'full', denialSignatures: [], runnerFailureRules: [] }
      } })
    })
    const component = await ctx.plugin(ptc, { binaryPath: file, required: true })
    const makeAgent = async (id, presentation, parent) => {
      const agent = { id, session: { id, mode: 'workspace-write', header: { cwd: dir } } }
      const scope = createScope(parent?.ctx ?? ctx, agent); agent.ctx = scope.ctx
      if (presentation) await agent.ctx.plugin({ inject: ['tools','systemPrompt'], apply(inner) { inner.tools.presentAs(presentation) } })
      await ctx.serial('agent/created', {agent}); return agent
    }
    const pure = await makeAgent('pure','ptc'), native = await makeAgent('native','native',pure), both = await makeAgent('both','both')
    const visible = agent => ctx.get('tools').schemas(agent).map(s => s.name)
    const until = async predicate => {
      const deadline = Date.now()+5000
      while (!predicate()) { if (Date.now()>deadline) throw new Error('host reconciliation timeout'); await new Promise(r => setTimeout(r, 10)) }
    }
    await until(() => visible(pure).includes('ops_batch'))
    await until(() => !visible(native).includes('ops_batch'))
    assert.equal(visible(both).includes('ops_result'), false)
    assert.equal(ctx.get('tools').schemas().length, 0)
    const assembled = await ctx.get('systemPrompt').assemble({scope:pure})
    assert.deepEqual(assembled.tools.map(t => t.name), ['run_code'])
    assert.ok(assembled.sections.some(s => s.text.includes('ops_batch')))
    assert.equal((await ctx.get('systemPrompt').assemble({scope:native})).sections.some(s => s.text.includes('ops_batch')), false)
    const def = ctx.get('tools').get('ops_batch', pure)
    write('host-copy', 'host data')
    const result = await def.execute({ action:'run',operations:[{op:'copy',path:'host-copy',to:'host-dest'}] }, {agent:pure,signal:new AbortController().signal})
    assert.equal(result.status,'completed',JSON.stringify(result)); assert.equal(result.sandbox.enforcement,'full')
    const hostJobs = new Map(); let jobNumber = 0
    await ctx.plugin(inner => inner.provide('jobs', {
      start(spec) {
        assert.equal(spec.owner, 'pure'); const id = `ops-${++jobNumber}`
        const hooks = spec.run({ updateProgress: line => assert.equal(typeof line, 'string') }); hostJobs.set(id, hooks); return id
      },
      async wait(id) { await hostJobs.get(id).done },
      remove(id) { hostJobs.delete(id) },
    }))
    const before = calls.length
    pure.session.mode = 'read-only'
    const readonly = await def.execute({action:'run',operations:[{op:'remove',path:'host-dest'}]}, {agent:pure,signal:new AbortController().signal})
    assert.equal(readonly.error.code,'POLICY_DENIED')
    pure.session.mode = 'workspace-write'; sandboxAvailable = false
    assert.equal((await def.execute({action:'run',operations:[{op:'remove',path:'host-dest'}]}, {agent:pure,signal:new AbortController().signal})).error.code,'SANDBOX_UNAVAILABLE')
    assert.equal(calls.length,before); assert.equal(hostJobs.size,0)
    sandboxAvailable = true
    const hostDestKept = exists('host-dest'); assert.equal(hostDestKept,true)
    const partialSandboxCtx = { get(name) {
      if (name === 'sandbox') return {confine:async argv=>({argv,enforcement:'partial'})}
      return ctx.get(name)
    } }
    const partial = await invoke(partialSandboxCtx,file,'batch',{action:'plan',operations:[{op:'remove',path:'host-dest'}]}, {agent:pure},new AbortController().signal)
    assert.equal(partial.status,'planned'); assert.equal(partial.sandbox.enforcement,'partial')
    const monitored = await def.execute({action:'plan',operations:[{op:'remove',path:'host-dest'}]}, {agent:pure,signal:new AbortController().signal})
    assert.equal(monitored.status,'planned'); assert.equal(hostJobs.size,0); assert.ok(jobNumber >= 1)
    const aborted = new AbortController(); aborted.abort()
    assert.equal((await invoke(ctx,file,'batch',{action:'run',operations:[{op:'remove',path:'host-dest'}]}, {agent:pure},aborted.signal)).error.effectState,'none')
    assert.equal(calls.length, before+2)
    const abortDuringWork = new AbortController()
    const interruptedCtx = { get(name) {
      if (name === 'sandboxPolicy') return { resolve: () => ({mode:'danger-full-access',workspaceRoot:dir}) }
      if (name === 'subprocess') return { spawn() {
        return { collected: { stdout: {readFrom:()=>({text:'',lossy:false})},stderr:{readFrom:()=>({text:'',lossy:false})} },
          done: new Promise(resolve => abortDuringWork.signal.addEventListener('abort', () => resolve({exitCode:null,signal:'SIGTERM'}), {once:true})) }
      } }
    } }
    const interruption = invoke(interruptedCtx,file,'batch',{action:'run',operations:[{op:'remove',path:'host-dest'}]}, {agent:pure},abortDuringWork.signal)
    abortDuringWork.abort()
    const unsettled = await interruption
    assert.equal(unsettled.error.code,'RESULT_UNKNOWN'); assert.match(unsettled.detailsRef,/^j-/)
    assert.ok(exists('host-dest')); assert.equal(hostJobs.size,0)
    // Unload rejects retained callbacks and cleans owned registrations, not foreign tools.
    const schemaBefore = JSON.stringify(ctx.get('tools').schemas(pure))
    ctx.get('tools').register({name:'foreign',description:'fixture',parameters:{type:'object'},output:{schema:{type:'object'},render:()=>[]},execute:()=>({})})
    await until(() => visible(pure).includes('ops_batch'))
    assert.equal(JSON.stringify(ctx.get('tools').schemas(pure).filter(s=>s.name.startsWith('ops_'))),
      JSON.stringify(JSON.parse(schemaBefore).filter(s=>s.name.startsWith('ops_'))))
    await component.dispose()
    assert.equal(visible(pure).includes('ops_batch'),false); assert.equal(visible(native).includes('ops_result'),false)
    assert.equal((await def.execute({}, {agent:pure,signal:new AbortController().signal})).error.code,'POLICY_DENIED')
    assert.ok(ctx.get('tools').get('foreign')); assert.equal(Object.hasOwn(ctx.get('tools'),'register'),false)
    console.log('ok: real DSH scopes/SDK, native+hybrid isolation, fail-closed authority and unload')
  } finally { for (const child of handles) child.kill(); await ctx.fiber.dispose() }

  // Native sandbox acceptance: original DSH providers, not mocks. No changes to
  // a user's workspace permissions; only the provider-owned temporary fixture.
  // Installed-package resolution is tested without source/build fallback.
  const isolatedPackage = path.join(dir,'runtime-package')
  fs.mkdirSync(isolatedPackage)
  fs.copyFileSync('package.json',path.join(isolatedPackage,'package.json'))
  const runtimeDir = path.resolve('runtime',`${process.platform}-${process.arch}`)
  fs.cpSync(runtimeDir,path.join(isolatedPackage,'runtime',`${process.platform}-${process.arch}`),{recursive:true})
  assert.ok(resolveWorker({}, {packageRoot:isolatedPackage}).startsWith(isolatedPackage))
  console.log('ok: installed runtime resolves without binaryPath or source build tree')
  const real = new Context(); real.logger.level = 0
  const outside = fs.mkdtempSync(path.join(os.tmpdir(),'ops-outside-'))
  const external = path.join(outside,'protected.txt'); fs.writeFileSync(external,'keep')
  try {
    await real.plugin(Subprocess)
    await real.plugin(Sandbox, {})
    const agent = { session: {id:'real-ptc',mode:'workspace-write',header:{cwd:dir}} }
    await real.plugin(inner => { inner.provide('sandboxPolicy',{resolve:({session})=>({mode:session.mode,workspaceRoot:dir,sessionId:session.id})}) })
    write('real-source','native')
    const call = (tool,args) => invoke(real,file,tool,args,{agent},new AbortController().signal)
    const copied = await call('batch',{action:'run',operations:[{op:'copy',path:'real-source',to:'real-copy'}]})
    assert.equal(copied.status,'completed',JSON.stringify(copied))
    agent.session.mode='read-only'
    const beforeStore = fs.readdirSync(path.join(dir,'.dsh-ops')).sort()
    const readonlyPage = await call('result',{action:'page',id:copied.detailsRef})
    assert.equal(readonlyPage.items[0].state,'completed',JSON.stringify(readonlyPage))
    assert.deepEqual(fs.readdirSync(path.join(dir,'.dsh-ops')).sort(),beforeStore)
    agent.session.mode='workspace-write'
    const denied=await call('batch',{root:outside,action:'run',operations:[{op:'remove',path:'protected.txt'}]})
    assert.equal(denied.status,'error',JSON.stringify(denied)); assert.ok(fs.existsSync(external))
    agent.session.mode='danger-full-access'
    const unrestricted=await call('batch',{root:outside,action:'run',operations:[{op:'remove',path:'protected.txt'}]})
    assert.equal(unrestricted.status,'completed',JSON.stringify(unrestricted)); assert.equal(fs.existsSync(external),false)
    assert.equal(unrestricted.sandbox.enforcement,undefined)
    assert.equal(path.basename(resolveWorker({}, {packageRoot:path.resolve('.')})), path.basename(file))
    assert.throws(() => resolveWorker({binaryPath:path.join(dir,'missing-worker.exe')}), /unavailable/)
    const staged = path.join(dir,'installed-package'); fs.mkdirSync(staged)
    fs.copyFileSync('package.json',path.join(staged,'package.json'))
    const runtime = path.dirname(resolveWorker({}, {packageRoot:path.resolve('.')}))
    fs.cpSync(runtime,path.join(staged,'runtime',`${process.platform}-${process.arch}`),{recursive:true})
    assert.ok(resolveWorker({}, {packageRoot:staged}).startsWith(staged))
    console.log('ok: original DSH native sandbox, readonly pages, outside-root denial and full-access outside-root execution')
  } finally { await real.fiber.dispose(); fs.rmSync(outside,{recursive:true,force:true}) }
} finally { fs.rmSync(dir, { recursive: true, force: true }) }
