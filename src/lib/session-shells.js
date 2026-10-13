/** Plugin-owned bash layers; permission changes never mutate the shared registry. */
import { BASH_TOOL } from './policy.js'
import { bashToolDefinition } from './shells.js'

export function mountSessionBash(ctx, config, shells) {
  if (!config.publishBashTool) return
  const bash = shells.bash
  if (!bash.available) {
    ctx.logger?.warn?.(`dsh-ops: bash unavailable: ${bash.detail}`)
    return
  }
  const entries = new Map()
  let ready = false
  let stopped = false
  const allowed = agent => {
    if (!ready || stopped || !agent?.session) return false
    try { return ctx.get('sandboxPolicy')?.resolve({ session: agent.session })?.mode === 'danger-full-access' }
    catch { return false }
  }
  const clear = entry => {
    entry.dispose?.()
    entry.dispose = undefined
  }
  const reconcile = () => {
    for (const entry of entries.values()) clear(entry)
    // Publish authorized ancestors before masking inheritance in restricted children.
    for (const [agent, entry] of entries) {
      if (!entry.ctx || !allowed(agent)) continue
      const definition = bashToolDefinition({ file: bash.file, source: bash.source, subprocess: ctx.get('subprocess') })
      const execute = definition.execute
      definition.execute = (args, exec) => {
        if (!allowed(exec?.agent)) throw new Error('Bash requires authoritative danger-full-access for this session.')
        return execute({ ...args, workdir: args?.workdir ?? exec.agent.session.header?.cwd }, exec)
      }
      try { entry.dispose = entry.ctx.tools.register(definition) }
      catch (error) { ctx.logger?.warn?.(`dsh-ops: bash publication failed: ${error.message}`) }
    }
    for (const [agent, entry] of entries) {
      if (!entry.ctx || allowed(agent) || stopped) continue
      if ((ctx.get('tools').schemas(agent) ?? []).some(tool => tool.name === BASH_TOOL)) {
        try { entry.dispose = entry.ctx.tools.restrict({ deny: [BASH_TOOL] }) }
        catch (error) { ctx.logger?.warn?.(`dsh-ops: inherited bash restriction failed: ${error.message}`) }
      }
    }
  }
  const attach = agent => {
    if (stopped || !agent?.ctx || entries.has(agent)) return
    const entry = { ctx: undefined, fiber: undefined, dispose: undefined }
    entries.set(agent, entry)
    entry.fiber = agent.ctx.plugin(child => {
      child.inject(['tools'], toolsCtx => {
        entry.ctx = toolsCtx
        reconcile()
      })
    })
  }
  const detach = agent => {
    const entry = entries.get(agent)
    if (!entry) return
    entries.delete(agent)
    clear(entry)
    reconcile()
    return entry.fiber?.dispose()
  }
  ctx.effect(() => async () => {
    stopped = true
    await Promise.all([...entries.keys()].map(detach))
  }, 'dsh-ops: session bash layers')
  ctx.on('agent/created', ({ agent }) => attach(agent))
  ctx.on('agent/disposed', ({ agent }) => detach(agent))
  ctx.on('session/event', (_session, event) => { if (event.type === 'sandbox/mode') reconcile() })
  ctx.inject(['sandboxPolicy', 'subprocess'], authorityCtx => {
    ready = true
    reconcile()
    authorityCtx.effect(() => () => { ready = false; reconcile() }, 'dsh-ops: bash authority and executor')
  })
  for (const agent of ctx.get('agents')?.list?.() ?? []) attach(agent)
}
