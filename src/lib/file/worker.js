/** Native file worker bridge. The host owns path resolution and DSH authority. */
import path from 'node:path'
import { resolveWorker } from '../ptc/runtime.js'

export { resolveWorker }

export function failure(code, message, phase = 'preflight', effectState = 'none') {
  return { status: code === 'POLICY_DENIED' ? 'rejected' : 'error', phase,
    changed: 0, matched: 0, skipped: 0, failed: 0, complete: false, omitted: 0,
    error: { code, phase, retryable: false, effectState,
      nextAction: effectState === 'none' ? 'Correct the request or restore host authority.' : 'Inspect the result; do not blindly retry after an unknown effect.', message } }
}

function absoluteTarget(raw, cwd) {
  if (typeof raw !== 'string' || raw.length === 0 || raw.includes('\0')) return undefined
  return path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(cwd, raw)
}
function inside(root, target) {
  const base = path.resolve(root)
  const candidate = path.resolve(target)
  const relative = path.relative(base, candidate)
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

export async function invoke(ctx, file, tool, args, exec, signal) {
  const session = exec?.agent?.session
  const cwd = session?.header?.cwd
  if (!session?.id || typeof cwd !== 'string' || !path.isAbsolute(cwd)) return failure('POLICY_DENIED', 'An authoritative session identity and cwd are required.')
  const policyService = ctx.get('sandboxPolicy')
  const subprocess = ctx.get('subprocess')
  if (!policyService?.resolve || !subprocess?.spawn) return failure('EXECUTOR_UNAVAILABLE', 'DSH policy and subprocess services are required.')
  let policy
  try { policy = policyService.resolve({ session }) } catch (error) { return failure('POLICY_DENIED', String(error?.message ?? error)) }
  if (!['read-only', 'workspace-write', 'danger-full-access'].includes(policy?.mode)
    || typeof policy.workspaceRoot !== 'string' || !path.isAbsolute(policy.workspaceRoot)) return failure('POLICY_DENIED', 'Invalid authoritative DSH policy.')

  if (tool === 'replace' && policy.mode === 'read-only') return failure('POLICY_DENIED', 'replace is unavailable in read-only mode.')
  const operationPath = absoluteTarget(args?.path ?? '.', cwd)
  if (!operationPath) return failure('INVALID_ARGUMENT', 'path must be a non-empty path.')
  if (policy.mode !== 'danger-full-access' && !inside(policy.workspaceRoot, operationPath)) {
    return failure('POLICY_DENIED', `path is outside the DSH workspace root: ${policy.workspaceRoot}`)
  }

  const workerArgs = { ...args, path: operationPath }
  const input = JSON.stringify({ root: cwd, scope: String(session.id), tool, args: workerArgs, read_only: policy.mode === 'read-only' })
  if (Buffer.byteLength(input) > 2 * 1024 * 1024) return failure('OUTPUT_LIMIT', 'Request exceeds the 2 MiB byte budget.')
  let confined
  try {
    let argv = [file]
    if (policy.mode !== 'danger-full-access') {
      const sandbox = ctx.get('sandbox')
      if (!sandbox?.confine) return failure('SANDBOX_UNAVAILABLE', 'No DSH process confinement provider; refusing unconfined execution.')
      confined = await sandbox.confine(argv, policy, signal)
      if (!['full', 'partial'].includes(confined?.enforcement) || !Array.isArray(confined.argv) || !confined.argv.length) return failure('SANDBOX_UNAVAILABLE', 'Invalid DSH confinement result; refusing unconfined execution.')
      argv = confined.argv
    }
    signal?.throwIfAborted?.()
    const current = policyService.resolve({ session })
    if (current.mode !== policy.mode || current.workspaceRoot !== policy.workspaceRoot) return failure('POLICY_DENIED', 'Authority changed during preparation.')
    const handle = subprocess.spawn({ argv, cwd, stdio: { stdin: { data: input }, stdout: { maxBytes: 128 * 1024 }, stderr: { maxBytes: 16 * 1024 } }, graceMs: 1000, signal })
    const outcome = await handle.done
    const stdout = handle.collected.stdout.readFrom(0)
    const stderr = handle.collected.stderr.readFrom(0)
    if (signal?.aborted || outcome.signal) return failure('RESULT_UNKNOWN', 'Worker interrupted; inspect postconditions.', 'execute', 'unknown')
    if (stdout.lossy) return failure('OUTPUT_LIMIT', 'Worker output exceeded the byte budget; operation facts may have changed.', 'verify', 'unknown')
    if (outcome.exitCode !== 0) return failure('RESULT_UNKNOWN', `Worker did not return a settled result: ${stderr.text.slice(0, 500)}`, 'execute', 'unknown')
    let value
    try { value = JSON.parse(stdout.text) } catch { return failure('RESULT_UNKNOWN', 'Worker returned invalid JSON; inspect postconditions.', 'verify', 'unknown') }
    return { ...value, sandbox: { mode: policy.mode, ...(confined ? { enforcement: confined.enforcement } : {}) } }
  } catch (error) {
    return failure(error?.code === 'ABORT_ERR' ? 'RESULT_UNKNOWN' : 'EXECUTOR_UNAVAILABLE', String(error?.message ?? error), 'execute', 'unknown')
  }
}
