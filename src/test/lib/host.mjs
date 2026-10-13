/**
 * A real host for the plugin.
 *
 * Every layer here is the production one: real Cordis `Context` and fiber
 * lifecycle, the harness's own `@deepseek-ai/dsh-tools` registry and
 * `@deepseek-ai/dsh-system-prompt` assembly, real registration scopes, and a
 * real FastCtx executable publishing real tools. Nothing is stubbed, so a
 * passing suite is evidence about the shipped composition rather than about a
 * test double.
 *
 * @module dsh-ops/test/host
 */

import { Context } from '@deepseek-ai/cordis'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { probeBinary, resolveBinary } from '../../lib/binary.js'
import { TOOL_PREFIX } from '../../lib/policy.js'
import { PACKAGE_ROOT, TEST_HOME } from './harness.mjs'

/**
 * Boot a context with the real prompt and tool services installed.
 * @param {object} [options] - boot inputs.
 * @param {boolean} [options.withTools] - install the tool registry (default true).
 * @param {boolean} [options.withSystemPrompt] - install the prompt registry (default true).
 * @param {boolean} [options.keepLogger] - keep Cordis's console logging (default false).
 * @returns {Promise<{ctx: Context, tools: any, prompt: any}>} the host.
 */
export async function bootHost({ withTools = true, withSystemPrompt = true, keepLogger = false } = {}) {
  const ctx = new Context()
  if (!keepLogger) {
    // Cordis logs service and plugin activity at info level; a gate that prints
    // it buries the assertions. Failures are asserted, not scrolled past.
    ctx.logger.level = 0
  }
  if (withSystemPrompt) {
    const SystemPrompt = (await import('@deepseek-ai/dsh-system-prompt')).default
    await ctx.plugin(SystemPrompt, {})
  }
  if (withTools) {
    const ToolRuntime = (await import('@deepseek-ai/dsh-tools')).default
    await ctx.plugin(ToolRuntime, { mode: 'native' })
  }
  return { ctx, tools: ctx.get('tools'), prompt: ctx.get('systemPrompt') }
}

/**
 * Load a fresh instance of the plugin module.
 *
 * A fresh module graph per mount keeps module-level state from leaking between
 * scenarios, at the cost of one import per call.
 * @param {string} [tag] - a cache-busting tag.
 * @returns {Promise<{apply: Function, name: string}>} the plugin module.
 */
export async function loadPlugin(tag = `${Date.now()}-${Math.random()}`) {
  const file = pathToFileURL(path.join(PACKAGE_ROOT, 'lib', 'index.js')).href
  return import(`${file}?tag=${tag}`)
}

/**
 * The environment a runtime probe runs with.
 *
 * The DSH home is this suite's throwaway one, never the developer's real
 * `~/.dsh`: `test/run.mjs` already injects one per suite, and setting it here as
 * well means a suite invoked directly still probes (and can only write) inside
 * the temporary directory. A probe that read the real home would resolve a
 * runtime the machine happens to have provisioned, which is exactly the
 * difference between a hermetic gate and this machine's own state.
 * @returns {NodeJS.ProcessEnv} the environment to resolve with.
 */
function probeEnvironment() {
  return { ...process.env, DSH_HOME: TEST_HOME }
}

/** The resolution this process already made, so later calls cost nothing. */
let runtimeResolution

/**
 * Resolve and probe the FastCtx executable without throwing.
 *
 * Every rung the plugin itself uses is searched, in the plugin's own order, and
 * the answer is cached for the process: a suite that resolves once and then
 * calls this from twenty checks probes once, not twenty times. No exception
 * escapes — an unusable environment is an answer, not a crash — so a caller can
 * decide whether to skip, to fail, or to press on.
 *
 * @param {object} [options] - resolution inputs.
 * @param {NodeJS.ProcessEnv} [options.env] - the environment to resolve with.
 * @param {boolean} [options.refresh] - resolve again instead of reusing the cached answer.
 * @returns {{ok: true, file: string, source: string, version: string}
 *   | {ok: false, reason: string, tried: {file: string, source: string, detail: string}[]}} the answer.
 */
export function tryResolveRuntime({ env = probeEnvironment(), refresh = false } = {}) {
  if (!refresh && runtimeResolution !== undefined) return runtimeResolution
  try {
    const resolved = resolveBinary({ packageRoot: PACKAGE_ROOT, env })
    const probe = probeBinary(resolved.file, { env })
    runtimeResolution = probe.ok
      ? { ok: true, file: resolved.file, source: resolved.source, version: probe.version }
      : {
        ok: false,
        reason: `${resolved.file} is not a working FastCtx build: ${probe.detail}`,
        tried: resolved.tried,
      }
  } catch (error) {
    runtimeResolution = {
      ok: false,
      reason: String(error?.message ?? error),
      tried: Array.isArray(error?.tried) ? error.tried : [],
    }
  }
  return runtimeResolution
}

/**
 * Resolve and probe the FastCtx executable the way the plugin does, for suites
 * that drive the tool surface directly.
 *
 * The instruction a missing runtime produces is the whole point of this being a
 * wrapper rather than a bare call: whoever hits it is told the two ways out
 * instead of being handed a search log.
 *
 * @param {object} [options] - resolution inputs, as {@link tryResolveRuntime}.
 * @returns {{file: string, source: string, version: string}} the ready runtime.
 * @throws {Error} when no usable executable exists.
 */
export function resolveRuntime(options = {}) {
  const resolved = tryResolveRuntime(options)
  if (resolved.ok) return { file: resolved.file, source: resolved.source, version: resolved.version }
  throw new Error(
    `no usable FastCtx runtime: ${resolved.reason}\n`
    + '  Build one from the vendored source:\n'
    + '    cargo build --release --locked --manifest-path vendor/fastctx/Cargo.toml\n'
    + '  or point the plugin at a build someone else made:\n'
    + '    DSH_OPS_FASTCTX_BIN=<path to the fastctx executable>\n'
    + `  searched (${resolved.tried.length}):\n`
    + resolved.tried.map((candidate) => `    ${candidate.source}: ${candidate.file} (${candidate.detail})`).join('\n'),
  )
}

/**
 * Mount the plugin and wait until the FastCtx tools appear (or the deadline
 * passes).
 * @param {object} options - mount inputs.
 * @param {Context} options.ctx - the host context.
 * @param {Record<string, unknown>} [options.config] - the plugin row config.
 * @param {number} [options.timeoutMs] - how long to wait for tools.
 * @param {number} [options.expectTools] - how many `ops_` tools to wait for.
 * @returns {Promise<{fiber: any, tools: string[]}>} the plugin fiber and the published tool names.
 */
export async function mountPlugin({ ctx, config = {}, timeoutMs = 10_000, expectTools = 1 }) {
  const plugin = await loadPlugin()
  const fiber = await ctx.plugin(plugin, config)
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const names = publicToolNames(ctx)
    if (names.length >= expectTools) return { fiber, tools: names }
    if (Date.now() > deadline) throw new Error(`mount timed out after ${timeoutMs}ms: expected ${expectTools} tools, got ${names.join(', ')}`)
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

/**
 * The tool names this plugin publishes, as the registry currently exposes them.
 * @param {Context} ctx - the host context.
 * @returns {string[]} the names, sorted.
 */
export function publicToolNames(ctx) {
  const schemas = ctx.get('tools')?.schemas?.() ?? []
  return schemas
    .map((schema) => schema.name)
    .filter((name) => typeof name === 'string' && name.startsWith(TOOL_PREFIX))
    .sort()
}

/**
 * Every registered tool name, sorted — the honest registry view, whatever
 * namespace a definition sits in.
 * @param {Context} ctx - the host context.
 * @returns {string[]} the names, sorted.
 */
export function registryNames(ctx) {
  const schemas = ctx.get('tools')?.schemas?.() ?? []
  return schemas.map((schema) => schema.name).sort()
}

/**
 * Whether the shared tool registry carries its own `register` property.
 *
 * `ToolRuntime.register` is a prototype method: an own property on the registry
 * instance can only be an installed override. This is the cheapest way to state
 * "this plugin did not touch the shared registry" as an assertion.
 * @param {Context} ctx - the host context.
 * @returns {boolean} whether an own override is present.
 */
export function registryHasOwnRegister(ctx) {
  return Object.hasOwn(ctx.get('tools'), 'register')
}

/**
 * The tool names visible from one registration scope.
 * @param {Context} ctx - the host context.
 * @param {unknown} scopeKey - the scope identity returned by {@link mountScopedToolPlugin}.
 * @returns {string[]} the names visible in that scope, sorted.
 */
export function scopedToolNames(ctx, scopeKey) {
  const schemas = ctx.get('tools')?.schemas?.(scopeKey) ?? []
  return schemas.map((schema) => schema.name).sort()
}

/**
 * Mount a plugin that registers one tool through a registration scope of its
 * own — the way an agent-plane plugin does.
 *
 * This is the shape the shipped incident broke: a scope's registration must
 * stay in that scope, and the same name must be registrable in a second scope.
 * Nothing here belongs to dsh-ops, which is exactly the point.
 * @param {Context} ctx - the host context (or a context mounted under it).
 * @param {object} options - the fixture inputs.
 * @param {string} options.scope - a display name for the fixture plugin.
 * @param {string} options.toolName - the tool name to register.
 * @param {string} [options.description] - the tool description.
 * @returns {Promise<{fiber: any, scopeKey: unknown, dispose: () => Promise<void>}>} the mounted fixture.
 */
export async function mountScopedToolPlugin(ctx, { scope, toolName, description }) {
  const { createScope, scopeOf } = await import('@deepseek-ai/dsh-scope')
  const created = createScope(ctx, { scope })
  const plugin = {
    name: `fixture-${scope}`,
    inject: ['tools'],
    apply(inner) {
      inner.tools.register({
        name: toolName,
        description: description ?? `a ${scope} registration for ${toolName}`,
        parameters: { type: 'object', properties: {} },
        output: { schema: { type: 'object' }, render: () => [] },
        execute: async () => ({}),
      })
    },
  }
  const fiber = await created.ctx.plugin(plugin)
  return { fiber, scopeKey: scopeOf(created.ctx), dispose: created.dispose }
}

/**
 * The assembled system prompt, as a name → text map.
 * @param {Context} ctx - the host context.
 * @returns {Promise<Map<string, string>>} the sections.
 */
export async function renderSections(ctx, agent) {
  const assembly = await ctx.get('systemPrompt').assemble({ agent })
  const sections = Array.isArray(assembly.sections) ? assembly.sections : []
  return new Map(sections.map((section) => [section.name, String(section.text ?? '')]))
}

/**
 * Call one registered tool the way the loop does: run the definition's body,
 * then render its canonical value into model-facing content.
 * @param {Context} ctx - the host context.
 * @param {string} name - the tool name.
 * @param {Record<string, unknown>} args - the arguments.
 * @param {AbortSignal} [signal] - the caller's signal.
 * @returns {Promise<{value: unknown, text: string, content: {type: string, text?: string}[]}>} the outcome.
 */
export async function callTool(ctx, name, args, signal = new AbortController().signal, agent) {
  const definition = ctx.get('tools').get(name)
  if (definition === undefined) throw new Error(`tool "${name}" is not registered`)
  const value = await definition.execute(args, { callId: 'test', name, arguments: args, signal, agent: agent ?? { session: { id: 'file-call', header: { cwd: process.cwd() } } } })
  const content = definition.output.render(args, value)
  return {
    value,
    content,
    text: content.filter((block) => block.type === 'text').map((block) => block.text).join('\n'),
  }
}

/**
 * Dispatch one `tools/pre-execute` waterfall exactly as the registry does and
 * report the decision.
 * @param {Context} ctx - the host context.
 * @param {string} toolName - the tool the model called.
 * @returns {Promise<unknown>} the decision, or the value the terminal `next()` produced.
 */
export async function preExecute(ctx, toolName) {
  const exec = { callId: 'test', name: toolName, arguments: {}, signal: new AbortController().signal }
  return ctx.waterfall('tools/pre-execute', exec, () => Promise.resolve({ kind: 'allow' }))
}

/**
 * Dispose the host and everything mounted under it.
 * @param {Context} ctx - the host context.
 * @returns {Promise<void>} resolves once disposal settles.
 */
export async function shutdown(ctx) {
  await ctx.fiber.dispose()
}
