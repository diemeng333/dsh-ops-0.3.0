/** PTC-only component. Public prompt assembly identifies the effective presentation;
 * never inspect private modeFor/layers, force presentAs, or infer mode from run_code existence.
 */
import { PTC_TOOLS, definition } from './contract.js'
import { publicToolName } from '../policy.js'
import { invoke, resolveWorker, failure } from './worker.js'
export const name = 'dsh-ops-ptc'
export function resolvePtcConfig(raw = {}) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('PTC config must be an object')
  for (const k of Object.keys(raw)) if (!['binaryPath', 'required'].includes(k)) throw new Error(`Unknown PTC config key: ${k}`)
  if (raw.binaryPath !== undefined && typeof raw.binaryPath !== 'string') throw new Error('binaryPath must be a string')
  if (raw.required !== undefined && typeof raw.required !== 'boolean') throw new Error('required must be boolean')
  return raw
}
async function ptcOnly(ctx, agent, signal) {
  if (!agent?.ctx || !ctx.get('ptcRuntime')) return false
  const assembly = await ctx.get('systemPrompt').assemble({ scope: agent, signal })
  // Host wire presentation distinguishes ptc (only reserved transport) from both/native.
  return assembly.tools.length === 1 && assembly.tools[0].name === 'run_code'
    && assembly.sections.some(section => section.name === 'tools:ptc-only' && section.text.trim() !== '')
}
export function apply(root, rawConfig) {
  const config = resolvePtcConfig(rawConfig)
  let file
  try { file = resolveWorker(config) } catch (e) {
    if (config.required) throw e
    root.logger?.warn?.(`dsh-ops: ${e.message}`); return
  }
  root.inject(['tools', 'systemPrompt', 'sandboxPolicy', 'subprocess'], ctx => {
    const entries = new Map(), active = new Map()
    let stopped = false, mutating = false, epoch = 0, chain = Promise.resolve()
    const clear = entry => { for (const dispose of entry.disposers.splice(0)) dispose() }
    const reconcile = () => {
      if (stopped || mutating) return
      const version = ++epoch
      // Withdraw synchronously on presentation changes: no schema leakage during async assembly.
      mutating = true
      for (const entry of entries.values()) clear(entry)
      mutating = false
      chain = chain.then(async () => {
        if (stopped || version !== epoch) return
        const ready = []
        for (const [agent, entry] of entries) {
          if (entry.ctx && await ptcOnly(ctx, agent).catch(() => false)) ready.push([agent, entry])
        }
        if (stopped || version !== epoch) return
        mutating = true
        try {
          for (const [agent, entry] of ready) {
            for (const tool of PTC_TOOLS) entry.disposers.push(entry.ctx.tools.register(definition(tool, async (args, exec) => {
              if (stopped || entries.get(agent) !== entry || exec?.agent !== agent || !await ptcOnly(ctx, agent, exec.signal).catch(() => false)) {
                return failure('POLICY_DENIED', 'The calling scope must be in authoritative PTC-only presentation.')
              }
              if (stopped || entries.get(agent) !== entry) return failure('POLICY_DENIED', 'PTC component or owning scope was disposed during preparation.')
              const controller = new AbortController()
              const abort = () => controller.abort(exec.signal?.reason)
              if (exec.signal?.aborted) abort(); else exec.signal?.addEventListener('abort', abort, { once: true })
              const timer = setTimeout(() => controller.abort(new Error('Worker deadline exceeded')), 300000); timer.unref?.()
              const work = monitoredInvoke(ctx, file, tool, args, exec, controller)
              active.set(controller, { owner: agent, promise: work })
              try { return await work }
              finally { clearTimeout(timer); active.delete(controller); exec.signal?.removeEventListener('abort', abort) }
            })))
          }
          // Native/both child scopes must not inherit PTC-only capabilities from ancestors.
          for (const [agent, entry] of entries) if (entry.ctx && !ready.some(([a]) => a === agent)) {
            const names = ctx.get('tools').schemas(agent).map(s => s.name)
            const deny = PTC_TOOLS.map(publicToolName).filter(n => names.includes(n))
            if (deny.length) entry.disposers.push(entry.ctx.tools.restrict({ deny }))
          }
        } finally { mutating = false }
      }).catch(e => ctx.logger?.warn?.(`dsh-ops: PTC publication failed: ${e.message}`))
    }
    const attach = agent => {
      if (stopped || entries.has(agent) || !agent?.ctx) return
      const entry = { disposers: [], ctx: undefined, fiber: undefined }; entries.set(agent, entry)
      entry.fiber = agent.ctx.plugin(child => { child.inject(['tools'], scoped => { entry.ctx = scoped; reconcile() }) })
    }
    const detach = agent => {
      const entry = entries.get(agent); if (!entry) return
      entries.delete(agent); mutating = true; clear(entry); mutating = false
      void entry.fiber?.dispose(); reconcile()
    }
    ctx.on('agent/created', ({ agent }) => attach(agent))
    ctx.on('agent/disposed', ({ agent }) => {
      for (const [controller, work] of active) {
        if (work.owner === agent) controller.abort(new Error('Owning agent disposed'))
      }
      detach(agent)
    })
    ctx.on('tools/change', reconcile)
    ctx.on('session/event', (_session, event) => {
      if (event.type === 'sandbox/mode') {
        for (const controller of active.keys()) controller.abort(new Error('Sandbox authority changed'))
        reconcile()
      }
    })
    ctx.effect(() => async () => {
      stopped = true; ++epoch
      for (const controller of active.keys()) controller.abort(new Error('PTC component unloaded'))
      await Promise.allSettled([...active.values()].map(work => work.promise))
      mutating = true
      for (const entry of entries.values()) clear(entry)
      await Promise.all([...entries.values()].map(e => e.fiber?.dispose()))
      entries.clear(); await chain
    }, 'dsh-ops: native PTC lifecycle')
    for (const agent of ctx.get('agents')?.list?.() ?? []) attach(agent)
  })
}

/** Reuse host job admission/ownership/kill when a controller is mounted. Otherwise
 * the same foreground work remains bounded by the host call signal and deadline.
 * Durable audit IDs are NOT a second background-job scheduler.
 */
async function monitoredInvoke(ctx, file, tool, args, exec, controller) {
  const jobs = ctx.get('jobs')
  if (tool !== 'batch' || typeof jobs?.start !== 'function') return invoke(ctx, file, tool, args, exec, controller.signal)
  let work, id
  try {
    id = jobs.start({ kind: 'ops', label: `ops_batch ${args?.action ?? ''}`, owner: exec.agent.session.id, outputLimitBytes: 4096,
      run(job) {
        job.updateProgress(`preflight 0/${args?.operations?.length ?? '?'} errors=0`)
        work = invoke(ctx, file, tool, args, exec, controller.signal).then(value => {
          job.updateProgress(`${value.phase ?? 'settled'} ${value.done ?? 0}/${value.total ?? '?'} errors=${value.failed ?? 0} unknown=${value.unknown ?? 0}`)
          return value
        })
        return { cancel: reason => controller.abort(new Error(reason ?? 'Host job cancelled')),
          done: work.then(value => ({ status: controller.signal.aborted ? 'killed' : value.status === 'completed' || value.status === 'planned' ? 'completed' : 'failed',
            result: JSON.stringify(value) }), error => ({ status: 'failed', detail: String(error) })) }
      },
    })
  } catch (e) {
    ctx.logger?.warn?.(`dsh-ops: host job admission unavailable; using bounded foreground execution: ${e.message}`)
    return work ?? invoke(ctx, file, tool, args, exec, controller.signal)
  }
  const value = await work
  // Collect and remove only the job this foreground call owns. No polling.
  try { await jobs.wait(id, 1000, exec.agent.session.id); jobs.remove(id, exec.agent.session.id) }
  catch { /* Host teardown may have already collected its owned record. */ }
  return value
}
