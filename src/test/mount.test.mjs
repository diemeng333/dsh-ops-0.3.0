/** Real Cordis/tool/prompt composition with the released independent components. */
import fs from 'node:fs'
import path from 'node:path'
import { resolveConfig } from '../lib/config.js'
import { BASH_TOOL, FILE_TOOLS, BACKGROUND_TOOLS, TOOLING_SECTION, publicToolName } from '../lib/policy.js'
import { FastCtxTools, childEnv } from '../lib/tools.js'
import { applyComponent } from '../lib/index.js'
import { assert, report, skipSuite, test, waitFor, withTempDir } from './lib/harness.mjs'
import { bootHost, callTool, mountPlugin, mountScopedToolPlugin, preExecute, publicToolNames,
  registryHasOwnRegister, registryNames, renderSections, resolveRuntime, scopedToolNames,
  shutdown, tryResolveRuntime } from './lib/host.mjs'
import Sandbox from '@deepseek-ai/dsh-sandbox-local'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
const EXPECTED = FILE_TOOLS.map(publicToolName).sort()
const FILE_SECTION = `${TOOLING_SECTION}:file`
const SHELL_SECTION = `${TOOLING_SECTION}:shell`
const BG_SECTION = `${TOOLING_SECTION}:background`
const runtime = tryResolveRuntime()
if (!runtime.ok) {
  if (process.env.DSH_OPS_REQUIRE_RUNTIME === '1') throw new Error(runtime.reason)
  skipSuite('mount', runtime.reason)
}
console.log(`  runtime: ${runtime.file} (${runtime.source}, ${runtime.version})`)
function foreignTool(name) {
  return { name, description: 'foreign fixture', parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'object' }, render: () => [] }, execute: async () => ({}) }
}
async function fileMount(ctx, config = {}) {
  if (!ctx.get('subprocess')) await ctx.plugin(Subprocess)
  if (!ctx.get('sandbox')) await ctx.plugin(Sandbox, {})
  if (!ctx.get('sandboxPolicy')) await ctx.plugin(inner => inner.provide('sandboxPolicy', {
    resolve: ({ session }) => ({ mode: session.mode, workspaceRoot: session.header.cwd, sessionId: session.id }),
  }))
  return mountPlugin({ ctx, config: { toolCallTimeoutMs: 5000, ...config }, expectTools: EXPECTED.length })
}
async function agentForCall(ctx, cwd, mode = 'danger-full-access') {
  const result = { id: 'file-call', session: { id: 'file-call', mode, header: { cwd } } }
  const { createScope } = await import('@deepseek-ai/dsh-scope')
  result.ctx = createScope(ctx, result).ctx
  return result
}
async function component(ctx, name, config = {}) {
  return ctx.plugin({ name: `fixture-${name}`, apply(inner) { return applyComponent(inner, { toolCallTimeoutMs: 5000, ...config }, name) } })
}
async function executor(ctx) {
  await ctx.plugin(inner => {
    inner.provide('subprocess', { spawn() { throw new Error('fixture does not execute commands') } })
    inner.provide('sandboxPolicy', { resolve({ session }) { return { mode: session.mode } } })
  })
}
async function agent(ctx, id, mode = 'danger-full-access', parent) {
  const { createScope } = await import('@deepseek-ai/dsh-scope')
  const result = { id, session: { mode, header: { cwd: process.cwd() } } }
  let scope
  await (parent?.ctx ?? ctx).plugin({ inject: ['tools'], apply(inner) { scope = createScope(inner, result) } })
  result.ctx = scope.ctx
  await ctx.serial('agent/created', { agent: result, source: 'startup' })
  return result
}
async function sections(ctx, currentAgent) { return renderSections(ctx, currentAgent) }
async function visible(ctx, currentAgent, expected) {
  await waitFor(() => expected.every(name => scopedToolNames(ctx, currentAgent).includes(name)), { timeoutMs: 5000, what: expected.join(', ') })
}
await test('file mount owns exactly four tools and never overrides the registry', async () => {
  const { ctx } = await bootHost()
  try {
    const { tools } = await fileMount(ctx)
    assert.deepEqual(tools, EXPECTED)
    assert.equal(registryHasOwnRegister(ctx), false)
    assert.deepEqual(registryNames(ctx), EXPECTED)
    assert.equal(registryNames(ctx).some(name => name.includes('__')), false)
  } finally { await shutdown(ctx) }
})
await test('foreign tools keep their names, and survive plugin disposal', async () => {
  const { ctx } = await bootHost()
  try {
    const { fiber } = await fileMount(ctx)
    const registry = ctx.get('tools')
    const names = ['foreign', 'mcp__someone-else__glob', 'mcp__fastctx__foreign', 'ops_lookalike']
    const disposers = names.map(name => registry.register(foreignTool(name)))
    for (const name of names) assert.ok(registryNames(ctx).includes(name))
    await fiber.dispose()
    assert.deepEqual(registryNames(ctx), [...names].sort())
    assert.equal(registryHasOwnRegister(ctx), false)
    for (const dispose of disposers) dispose()
    assert.deepEqual(registryNames(ctx), [])
  } finally { await shutdown(ctx) }
})
await test('the same foreign name registers in two real scopes without becoming global', async () => {
  const { ctx } = await bootHost()
  try {
    await fileMount(ctx)
    const first = await mountScopedToolPlugin(ctx, { scope: 'first', toolName: 'subagent' })
    const second = await mountScopedToolPlugin(ctx, { scope: 'second', toolName: 'subagent' })
    for (const scope of [first.scopeKey, second.scopeKey]) assert.ok(scopedToolNames(ctx, scope).includes('subagent'))
    assert.equal(registryNames(ctx).includes('subagent'), false)
    await first.dispose(); await second.dispose()
    assert.deepEqual(registryNames(ctx), EXPECTED)
  } finally { await shutdown(ctx) }
})
await test('real FastCtx calls return data and propagate server errors promptly', async () => {
  const { ctx } = await bootHost()
  try {
    await fileMount(ctx)
    await withTempDir('glob', async dir => {
      fs.writeFileSync(path.join(dir, 'alpha.txt'), 'alpha\n')
      const agent = await agentForCall(ctx, dir)
      const result = await callTool(ctx, publicToolName('glob'), { pattern: ['*.txt'], path: dir }, undefined, agent)
      assert.match(result.text, /alpha\.txt/)
      assert.equal(result.value.items[0], path.join(dir, 'alpha.txt'))
      const missing = await callTool(ctx, publicToolName('inspect_local_file'), { path: path.join(dir, 'missing.txt') }, undefined, agent)
      assert.equal(missing.value.error.code, 'NOT_FOUND')
    })
  } finally { await shutdown(ctx) }
})
await test('native file paths resolve from session cwd and enforce workspace-write boundaries', async () => {
  const { ctx } = await bootHost()
  try {
    await fileMount(ctx)
    await withTempDir('native-paths', async dir => {
      fs.writeFileSync(path.join(dir, 'cwd.txt'), 'cwd\n')
      const workspace = await agentForCall(ctx, dir, 'workspace-write')
      const relative = await callTool(ctx, publicToolName('glob'), { pattern: ['cwd.txt'], path: '.' }, undefined, workspace)
      assert.equal(relative.value.status, 'completed')
      assert.deepEqual(relative.value.items, [path.join(dir, 'cwd.txt')])
      const outside = path.join(path.dirname(dir), 'outside-native.txt')
      fs.writeFileSync(outside, 'outside\n')
      try {
        const denied = await callTool(ctx, publicToolName('inspect_local_file'), { path: outside }, undefined, workspace)
        assert.equal(denied.value.error.code, 'POLICY_DENIED')
        assert.ok(denied.value.error.message.includes(dir))
      } finally { fs.rmSync(outside, { force: true }) }
    })
  } finally { await shutdown(ctx) }
})
await test('the file component renders its live tools and retires both legacy sections', async () => {
  const { ctx } = await bootHost()
  try {
    const { fiber } = await fileMount(ctx)
    const rendered = await sections(ctx)
    for (const name of EXPECTED) assert.ok(rendered.get(FILE_SECTION).includes(name))
    for (const name of ['dsh-ops:host-shell-policy', 'mcp:fastctx', SHELL_SECTION, BG_SECTION]) assert.equal(rendered.has(name), false)
    await fiber.dispose()
    assert.deepEqual(publicToolNames(ctx), [])
    assert.equal((await sections(ctx)).has(FILE_SECTION), false)
  } finally { await shutdown(ctx) }
})
await test('optional missing runtime degrades honestly, required runtime rejects activation', async () => {
  const { ctx } = await bootHost()
  try {
    const binaryPath = path.join(process.cwd(), 'no-such-fastctx.exe')
    const { fiber } = await mountPlugin({ ctx, config: { binaryPath }, expectTools: 0 })
    assert.deepEqual(publicToolNames(ctx), [])
    assert.equal((await sections(ctx)).get(FILE_SECTION) ?? '', '')
    await fiber.dispose()
    await assert.rejects(() => mountPlugin({ ctx, config: { binaryPath, required: true }, expectTools: 0 }), /binaryPath/)
  } finally { await shutdown(ctx) }
})
await test('promptPolicy false leaves tools live with no prompt section', async () => {
  const { ctx } = await bootHost()
  try {
    await fileMount(ctx, { promptPolicy: false })
    assert.deepEqual(publicToolNames(ctx), EXPECTED)
    assert.equal((await sections(ctx)).has(FILE_SECTION), false)
  } finally { await shutdown(ctx) }
})
await test('bash is scoped to authorized sessions, responds to mode changes, and unloads cleanly', async () => {
  const { ctx } = await bootHost()
  try {
    await executor(ctx)
    const shell = await component(ctx, 'shell', { bashPath: process.execPath })
    const full = await agent(ctx, 'full')
    await visible(ctx, full, [BASH_TOOL])
    const restricted = await agent(ctx, 'restricted', 'workspace-write', full)
    await waitFor(() => !scopedToolNames(ctx, restricted).includes(BASH_TOOL), { timeoutMs: 5000 })
    assert.equal(registryNames(ctx).includes(BASH_TOOL), false)
    const text = (await sections(ctx, full)).get(SHELL_SECTION)
    assert.ok(text.includes(BASH_TOOL))
    assert.equal(((await sections(ctx, restricted)).get(SHELL_SECTION) ?? '').includes(BASH_TOOL), false)
    const definition = ctx.get('tools').get(BASH_TOOL, full)
    full.session.mode = 'read-only'
    await ctx.serial('session/event', full.session, { type: 'sandbox/mode' })
    assert.equal(scopedToolNames(ctx, full).includes(BASH_TOOL), false)
    await assert.rejects(async () => definition.execute({ command: 'echo no' }, { agent: full }), /authoritative danger-full-access/)
    full.session.mode = 'danger-full-access'
    await ctx.serial('session/event', full.session, { type: 'sandbox/mode' })
    await visible(ctx, full, [BASH_TOOL])
    await shell.dispose()
    assert.equal(scopedToolNames(ctx, full).includes(BASH_TOOL), false)
    assert.equal((await sections(ctx, full)).has(SHELL_SECTION), false)
    assert.equal(registryHasOwnRegister(ctx), false)
  } finally { await shutdown(ctx) }
})
await test('without permission authority or subprocess a resolved bash is not advertised', async () => {
  const { ctx } = await bootHost()
  try {
    await component(ctx, 'shell', { bashPath: process.execPath })
    const full = await agent(ctx, 'missing-authority')
    assert.equal(scopedToolNames(ctx, full).includes(BASH_TOOL), false)
    assert.equal(((await sections(ctx, full)).get(SHELL_SECTION) ?? '').includes(BASH_TOOL), false)
  } finally { await shutdown(ctx) }
})
await test('advise preserves host tools; explicit deny works without ops commands and lifts on unload', async () => {
  const { ctx } = await bootHost()
  try {
    const registry = ctx.get('tools')
    const disposers = ['pwsh', 'bash', 'pwsh_persistent'].map(name => registry.register(foreignTool(name)))
    const advice = await component(ctx, 'shell', { publishBashTool: false })
    const advised = await agent(ctx, 'advised')
    assert.ok(scopedToolNames(ctx, advised).includes('bash'))
    assert.deepEqual(await preExecute(ctx, 'bash'), { kind: 'allow' })
    await advice.dispose()
    const denial = await component(ctx, 'shell', { shellPolicy: 'deny-host-shell', publishBashTool: false })
    await waitFor(() => ctx.get('tools').get('bash') !== undefined)
    // Cordis injection fibers settle after the component fiber mounts.
    await new Promise(resolve => setImmediate(resolve))
    const denied = await agent(ctx, 'denied')
    await waitFor(() => !scopedToolNames(ctx, denied).includes('bash'), { timeoutMs: 5000 })
    for (const name of ['bash', 'pwsh', 'pwsh_persistent']) {
      assert.equal(scopedToolNames(ctx, denied).includes(name), false)
      assert.equal((await preExecute(ctx, name)).kind, 'deny')
      assert.ok(registryNames(ctx).includes(name))
    }
    for (const name of ['ops_glob', 'read', 'edit']) assert.deepEqual(await preExecute(ctx, name), { kind: 'allow' })
    await denial.dispose()
    assert.ok(scopedToolNames(ctx, denied).includes('bash'))
    assert.deepEqual(await preExecute(ctx, 'bash'), { kind: 'allow' })
    for (const dispose of disposers) dispose()
  } finally { await shutdown(ctx) }
})
await test('file/background share runtime, but command tools never leak into global or restricted scopes', async () => {
  const { ctx } = await bootHost()
  try {
    await executor(ctx)
    const file = await fileMount(ctx)
    const background = await component(ctx, 'background')
    const full = await agent(ctx, 'background-full')
    const jobs = BACKGROUND_TOOLS.map(publicToolName)
    await visible(ctx, full, jobs)
    const child = await agent(ctx, 'background-restricted', 'read-only', full)
    await waitFor(() => jobs.every(name => !scopedToolNames(ctx, child).includes(name)), { timeoutMs: 5000 })
    assert.deepEqual(registryNames(ctx), EXPECTED)
    assert.equal(scopedToolNames(ctx, full).includes('ops_run'), false)
    assert.match((await sections(ctx, full)).get(BG_SECTION), /Only operate on job IDs you started/)
    await file.fiber.dispose()
    await visible(ctx, full, jobs)
    assert.deepEqual(registryNames(ctx), [])
    await background.dispose()
    assert.equal(jobs.some(name => scopedToolNames(ctx, full).includes(name)), false)
    assert.equal((await sections(ctx, full)).has(BG_SECTION), false)
  } finally { await shutdown(ctx) }
})
await test('a dead server withdraws and republishes real file tools', async () => {
  const registered = new Map(), messages = []
  const surface = new FastCtxTools({ ctx: { tools: { register(definition) {
    registered.set(definition.name, definition); return () => registered.delete(definition.name)
  } } }, config: resolveConfig({ enableShellTools: false, toolCallTimeoutMs: 5000 }), runtime: resolveRuntime(),
    report: message => messages.push(message) })
  try {
    assert.deepEqual((await surface.start()).sort(), EXPECTED)
    surface.client.child.kill()
    await waitFor(() => !surface.client, { timeoutMs: 5000 })
    assert.deepEqual([...registered.keys()], [])
    await waitFor(() => surface.names().length === EXPECTED.length, { timeoutMs: 10000 })
    assert.ok(messages.some(message => message.includes('reconnected')))
  } finally { await surface.stop() }
  assert.equal(registered.size, 0)
})
await test('missing approved bash blocks background publication and isolates shared runtime policy', async () => {
  const { ctx } = await bootHost()
  try {
    await executor(ctx)
    await fileMount(ctx)
    const ready = []
    ctx.logger.exporter({ levels: { default: 4 }, export(message) { ready.push(message.args.join(' ')) } })
    const previous = process.env.FASTCTX_BASH
    process.env.FASTCTX_BASH = process.execPath
    let background
    try {
      background = await component(ctx, 'background', { bashPath: path.join(process.cwd(), 'absent-approved-bash.exe') })
      // A conflicting file lease with an approved executor must not lend its
      // executor to this background component. Inspect its real model surface.
      await waitFor(() => ready.some(message => message.includes('background component')), { timeoutMs: 5000, what: 'background handshake with disabled executor' })
      const full = await agent(ctx, 'no-approved-executor')
      await new Promise(resolve => setImmediate(resolve))
      for (const name of BACKGROUND_TOOLS.map(publicToolName)) assert.equal(scopedToolNames(ctx, full).includes(name), false)
      assert.deepEqual(registryNames(ctx), EXPECTED)
      assert.equal(((await sections(ctx, full)).get(BG_SECTION) ?? ''), '')
    } finally {
      if (previous === undefined) delete process.env.FASTCTX_BASH
      else process.env.FASTCTX_BASH = previous
      await background?.dispose()
    }
  } finally { await shutdown(ctx) }
})

await test('FastCtx child drops credentials and DSH facts', () => {
  const env = childEnv({ PATH: 'C:\\bin', HOME: 'C:\\home', GH_CONFIG_DIR: 'C:\\gh', GH_TOKEN: 'fixture', DSH_HOME: 'C:\\dsh', DEEPSEEK_API_KEY: 'fixture' })
  assert.equal(env.PATH, 'C:\\bin'); assert.equal(env.GH_CONFIG_DIR, 'C:\\gh')
  for (const key of ['GH_TOKEN', 'DSH_HOME', 'DEEPSEEK_API_KEY']) assert.equal(Object.hasOwn(env, key), false)
})
report('mount')
