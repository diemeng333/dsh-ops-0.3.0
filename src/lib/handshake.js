/**
 * The MCP stdio client this plugin owns.
 *
 * It is the plugin's transport: `lib/tools.js` keeps one long-lived client
 * connected to the FastCtx server for as long as the plugin is mounted, calls
 * `tools/call` through it, and rebuilds the whole tool generation after a
 * reconnect. The same client also serves the callers that need ground truth
 * without a host — `dsh-ops status`, and the suite that pins the tool surface
 * the plugin's prompt policy advertises.
 *
 * It speaks newline-delimited JSON-RPC 2.0 and implements only the four methods
 * those callers use.
 *
 * @module dsh-ops/handshake
 */

import { spawn } from 'node:child_process'

/** Exact owned clients only: never enumerate/kill shared runtime-host processes. */
const ownedClients = new Set()
function stopOwnedClients() {
  for (const client of ownedClients) {
    if (client.exitInfo === undefined) client.child.kill()
  }
}
function track(client) {
  if (ownedClients.size === 0) process.on('exit', stopOwnedClients)
  ownedClients.add(client)
}
function untrack(client) {
  ownedClients.delete(client)
  if (ownedClients.size === 0) process.removeListener('exit', stopOwnedClients)
}

/** The MCP revision this client announces. */
export const PROTOCOL_VERSION = '2025-06-18'

/** Error raised when the server does not answer in time. */
export class McpTimeoutError extends Error {
  /**
   * @param {string} method - the unanswered method.
   * @param {number} timeoutMs - the deadline that expired.
   */
  constructor(method, timeoutMs) {
    super(`MCP server did not answer ${method} within ${timeoutMs} ms`)
    this.name = 'McpTimeoutError'
    this.method = method
  }
}

/** Error raised when the server answers with a JSON-RPC error. */
export class McpServerError extends Error {
  /**
   * @param {string} method - the failing method.
   * @param {{code?: number, message?: string}} error - the JSON-RPC error object.
   */
  constructor(method, error) {
    super(`MCP ${method} failed: ${error?.message ?? JSON.stringify(error)}`)
    this.name = 'McpServerError'
    this.code = error?.code
  }
}

/** One newline-delimited JSON-RPC client over a spawned server's stdio. */
export class McpStdioClient {
  /**
   * @param {import('node:child_process').ChildProcess} child - the spawned server.
   * @param {number} timeoutMs - the default per-request deadline.
   */
  constructor(child, timeoutMs) {
    this.child = child
    this.timeoutMs = timeoutMs
    this.nextId = 1
    /** @type {Map<number, {resolve: (value: unknown) => void, reject: (error: Error) => void, method: string}>} */
    this.pending = new Map()
    /** @type {string[]} */
    this.stderrLines = []
    this.buffer = ''
    this.closed = false
    this.closing = undefined
    track(this)
    /** How this connection ended, or undefined while it is live. */
    this.exitInfo = undefined

    /**
     * Settles once this connection is over, however it ended: a clean exit, a
     * crash, or a spawn failure. A long-lived owner watches it to notice a dead
     * server between calls instead of discovering it on the next timeout.
     * @type {Promise<{code: number|null, signal: string|null, error?: Error}>}
     */
    this.exited = new Promise((resolve) => { this.resolveExit = resolve })

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => this.#ingest(chunk))
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => {
      for (const line of String(chunk).split('\n')) if (line.trim() !== '') this.stderrLines.push(line)
    })
    // A write to a server that is already gone must surface as this request's
    // rejection (below), not as an unhandled stream error that kills the host.
    child.stdin.on('error', () => {})

    const settleExit = (info) => {
      if (this.exitInfo !== undefined) return
      this.exitInfo = info
      untrack(this)
      this.closed = true
      const reason = info.error !== undefined
        ? new Error(`MCP server could not be started: ${info.error.message}`)
        : new Error(`MCP server exited (code ${info.code ?? 'null'}, signal ${info.signal ?? 'none'})`)
      for (const entry of this.pending.values()) entry.reject(reason)
      this.pending.clear()
      this.resolveExit(info)
    }
    child.once('exit', (code, signal) => settleExit({ code, signal }))
    child.once('error', (error) => settleExit({ code: null, signal: null, error }))
    // A live child with a closed reply transport is unusable. Do not leave it
    // connected to the shared runtime until an unrelated next request times out.
    child.stdout.once('end', () => { if (!this.closed) void this.close().catch(() => {}) })
  }

  /**
   * Spawn one server and return a connected client (the MCP handshake is not
   * performed; call {@link McpStdioClient#initialize}).
   * @param {object} options - spawn inputs.
   * @param {string} options.file - the executable.
   * @param {string[]} [options.args] - its arguments.
   * @param {string} [options.cwd] - working directory.
   * @param {NodeJS.ProcessEnv} [options.env] - environment.
   * @param {number} [options.timeoutMs] - the default per-request deadline.
   * @returns {McpStdioClient} the client.
   */
  static start({ file, args = [], cwd, env = process.env, timeoutMs = 60_000 }) {
    const child = spawn(file, args, {
      cwd,
      // FastCtx's identity-aware parent watcher is the crash/SIGKILL backstop.
      // Never inherit an ambient escape hatch that disables owner monitoring.
      env: { ...env, FASTCTX_NO_PARENT_WATCH: '0' },
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    return new McpStdioClient(child, timeoutMs)
  }

  /**
   * Consume whatever arrived and settle every complete line.
   * @param {string} chunk - decoded stdout.
   * @returns {void}
   */
  #ingest(chunk) {
    this.buffer += chunk
    let index
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index).trim()
      this.buffer = this.buffer.slice(index + 1)
      if (line === '') continue
      let message
      try {
        message = JSON.parse(line)
      } catch {
        // A non-JSON line on stdout is the server's problem, not a protocol
        // message; recording it keeps the diagnosis attached to a failure.
        this.stderrLines.push(`non-JSON stdout: ${line.slice(0, 400)}`)
        continue
      }
      const entry = message.id === undefined ? undefined : this.pending.get(message.id)
      if (entry === undefined) continue
      if (message.error !== undefined) entry.reject(new McpServerError(entry.method, message.error))
      else entry.resolve(message.result)
    }
  }

  /**
   * Send one request and await its result.
   * @param {string} method - the JSON-RPC method.
   * @param {Record<string, unknown>} [params] - its parameters.
   * @param {object} [options] - per-request overrides.
   * @param {number} [options.timeoutMs] - this request's deadline.
   * @param {AbortSignal} [options.signal] - cancels this request when aborted.
   * @returns {Promise<any>} the result.
   */
  request(method, params = {}, options = {}) {
    const { timeoutMs = this.timeoutMs, signal } = options
    if (this.closed) return Promise.reject(new Error(`MCP server is gone; cannot send ${method}`))
    if (signal?.aborted === true) {
      return Promise.reject(new Error(`MCP ${method} was canceled before it was sent`))
    }
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      let timer
      let settled = false
      const finish = (settle, value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        this.pending.delete(id)
        settle(value)
      }
      const onAbort = () => finish(reject, new Error(`MCP ${method} was canceled`))
      timer = setTimeout(() => finish(reject, new McpTimeoutError(method, timeoutMs)), timeoutMs)
      timer.unref?.()
      signal?.addEventListener('abort', onAbort, { once: true })
      this.pending.set(id, {
        method,
        resolve: (value) => finish(resolve, value),
        reject: (error) => finish(reject, error),
      })
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })
  }

  /**
   * Send one notification (no reply is expected).
   * @param {string} method - the JSON-RPC method.
   * @param {Record<string, unknown>} [params] - its parameters.
   * @returns {void}
   */
  notify(method, params = {}) {
    if (this.closed) return
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`)
  }

  /**
   * Perform the MCP handshake.
   * @param {string} [clientName] - the name to announce.
   * @returns {Promise<{protocolVersion: string, serverInfo: {name: string, version: string}, instructions?: string, capabilities: Record<string, unknown>}>} the server's answer.
   */
  async initialize(clientName = 'dsh-ops') {
    const result = await this.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: clientName, version: '0.1.0' },
    })
    this.notify('notifications/initialized', {})
    return result
  }

  /**
   * List the server's tools.
   * @returns {Promise<{name: string, description?: string, inputSchema?: Record<string, unknown>, outputSchema?: Record<string, unknown>}[]>} the tools.
   */
  async listTools() {
    const result = await this.request('tools/list', {})
    return result?.tools ?? []
  }

  /**
   * Call one tool and return its raw result.
   * @param {string} toolName - the server's own tool name.
   * @param {Record<string, unknown>} args - the arguments.
   * @param {object} [options] - per-request overrides (deadline, cancellation).
   * @returns {Promise<{content?: unknown[], isError?: boolean, structuredContent?: unknown}>} the result.
   */
  async callTool(toolName, args, options = {}) {
    return this.request('tools/call', { name: toolName, arguments: args }, options)
  }

  /**
   * Stop the server and wait for the process to settle.
   *
   * Idempotent, and safe to call on a connection that already ended: the
   * process is only signalled while it is still alive.
   * @returns {Promise<void>} resolves once the child is gone.
   */
  close() {
    if (this.closing) return this.closing
    if (this.exitInfo !== undefined) return Promise.resolve()
    this.closed = true
    for (const entry of this.pending.values()) entry.reject(new Error('MCP client is closing'))
    this.pending.clear()
    this.closing = this.#stopChild()
    return this.closing
  }

  async #stopChild() {
    this.child.stdin.end()
    this.child.kill()
    let timer
    try {
      await Promise.race([
        this.exited,
        new Promise((resolve, reject) => {
          timer = setTimeout(() => {
            this.child.kill('SIGKILL')
            timer = setTimeout(() => reject(new Error('MCP child did not exit after forced shutdown')), 2000)
          }, 2000)
        }),
      ])
    } finally { clearTimeout(timer) }
  }
}
