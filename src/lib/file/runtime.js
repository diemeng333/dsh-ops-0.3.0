import { definition, FILE_TOOLS } from './contract.js'
import { invoke, failure } from './worker.js'

export class NativeFileTools {
  constructor({ ctx, config, report }) {
    this.ctx = ctx
    this.config = config
    this.report = report ?? (() => {})
    this.file = undefined
    this.active = new Set()
    this.disposers = []
    this.stopped = false
  }

  async start() {
    this.file = this.config.workerPath
    if (!this.file) {
      if (this.config.required) throw new Error('Native file worker path is unavailable.')
      return []
    }
    for (const rawName of FILE_TOOLS) {
      this.disposers.push(this.ctx.tools.register(definition(rawName, (args, exec) => this.call(rawName, args, exec))))
    }
    return FILE_TOOLS.map(name => `ops_${name}`)
  }

  async call(tool, args, exec) {
    if (this.stopped) return failure('POLICY_DENIED', 'Native file component is disposed.')
    const controller = new AbortController()
    const abort = () => controller.abort(exec?.signal?.reason)
    if (exec?.signal?.aborted) abort()
    else exec?.signal?.addEventListener?.('abort', abort, { once: true })
    this.active.add(controller)
    try { return await invoke(this.ctx, this.file, tool, args, exec, controller.signal) }
    finally {
      this.active.delete(controller)
      exec?.signal?.removeEventListener?.('abort', abort)
    }
  }

  async stop() {
    this.stopped = true
    for (const controller of this.active) controller.abort(new Error('Native file component unloaded'))
    await Promise.allSettled([...this.active])
    for (const dispose of this.disposers.splice(0)) dispose()
  }
}
