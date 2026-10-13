/** Native worker bridge. Every execution uses DSH policy, confinement and process governance. */
import { randomUUID } from 'node:crypto'
import path from 'node:path'
export { resolveWorker } from './runtime.js'
export function failure(code, message, effectState = 'none') {
  return { status: 'error', error: { code, phase: effectState === 'none' ? 'preflight' : 'execute', retryable: false, effectState,
    nextAction: effectState === 'none' ? 'Correct the request or restore host authority.' : 'Inspect the persistent job manifest; never blindly rerun an interrupted batch.', message } }
}
export async function invoke(ctx, file, tool, args, exec, signal) {
  const session = exec?.agent?.session
  if (!session?.id) return failure('POLICY_DENIED', 'An authoritative session identity is required.')
  const policyService = ctx.get('sandboxPolicy'), subprocess = ctx.get('subprocess')
  if (!policyService?.resolve || !subprocess?.spawn) return failure('EXECUTOR_UNAVAILABLE', 'DSH policy and subprocess services are required.')
  const jobId = tool === 'batch' ? (args?.action === 'run' || args?.action === 'plan' ? `j-${randomUUID()}` : args?.id) : undefined
  const errorResult = (code, message, effect = 'none') => ({ ...failure(code, message, effect), ...(jobId ? { detailsRef: jobId } : {}) })
  let policy, confined, spawned = false
  try {
    policy = policyService.resolve({ session })
    if (!['read-only', 'workspace-write', 'danger-full-access'].includes(policy?.mode)
      || !path.isAbsolute(policy?.workspaceRoot ?? '')) return failure('POLICY_DENIED', 'Invalid authoritative policy.')
    // Model root is a selection, never an authority override. The DSH sandbox
    // retains the original workspaceRoot even when operations select another root.
    if (args?.root !== undefined && (typeof args.root !== 'string' || !path.isAbsolute(args.root))) return failure('INVALID_ARGUMENT', 'root must be an absolute path.')
    const operationRoot = args?.root ?? policy.workspaceRoot
    const { root: _selectedRoot, ...workerArgs } = args ?? {}
    const readOnly = policy.mode === 'read-only'
    if (readOnly && !(tool === 'result' && args?.action === 'page')) return failure('POLICY_DENIED', 'Read-only permits result pages, not mutations or new audit records.')
    const input = JSON.stringify({ root: operationRoot, scope: String(session.id), tool, args: workerArgs, read_only: readOnly, ...(jobId ? { job_id: jobId } : {}) })
    if (Buffer.byteLength(input) > 2 * 1024 * 1024) return failure('OUTPUT_LIMIT', 'Request exceeds the 2 MiB byte budget.')
    let argv = [file]
    if (policy.mode !== 'danger-full-access') {
      const sandbox = ctx.get('sandbox')
      if (!sandbox?.confine) return failure('SANDBOX_UNAVAILABLE', 'No DSH process confinement provider; refusing unconfined execution.')
      confined = await sandbox.confine(argv, policy, signal)
      if (!['full', 'partial'].includes(confined?.enforcement) || !Array.isArray(confined.argv) || !confined.argv.length) {
        return failure('SANDBOX_UNAVAILABLE', 'Invalid DSH confinement result; refusing unconfined execution.')
      }
      argv = confined.argv
    }
    signal.throwIfAborted()
    // Authority may change during asynchronous sandbox preparation.
    const current = policyService.resolve({ session })
    if (current.mode !== policy.mode || current.workspaceRoot !== policy.workspaceRoot) return failure('POLICY_DENIED', 'Authority changed during preparation.')
    const handle = subprocess.spawn({ argv, cwd: policy.workspaceRoot,
      stdio: { stdin: { data: input }, stdout: { maxBytes: 128 * 1024 }, stderr: { maxBytes: 16 * 1024 } },
      graceMs: 1000, signal })
    spawned = true
    const outcome = await handle.done
    const stdout = handle.collected.stdout.readFrom(0), stderr = handle.collected.stderr.readFrom(0)
    if (signal.aborted || outcome.signal) return errorResult('RESULT_UNKNOWN', 'Worker interrupted; durable write-ahead records preserve possible effects.', 'unknown')
    if (confined && runnerFailure(outcome.exitCode, stderr.text, confined.runnerFailureRules ?? [])) {
      return failure('SANDBOX_UNAVAILABLE', 'DSH confinement runner failed before executing the worker.')
    }
    if (stdout.lossy) return errorResult('OUTPUT_LIMIT', 'Worker output exceeded the byte budget; operation facts remain in the audit store.', 'unknown')
    if (outcome.exitCode !== 0) {
      const denied = confined?.denialSignatures?.some(s => stderr.text.toLowerCase().includes(s.toLowerCase()))
      return errorResult(denied ? 'POLICY_DENIED' : 'RESULT_UNKNOWN', 'Worker did not return a settled result; inspect audit records.', 'unknown')
    }
    let value
    try { value = JSON.parse(stdout.text) } catch { return errorResult('RESULT_UNKNOWN', 'Worker returned invalid JSON; inspect audit records.', 'unknown') }
    return { ...value, ...(tool === 'batch' ? { root: operationRoot } : {}), ...(value.status === 'error' && jobId ? { detailsRef: jobId } : {}), sandbox: { mode: policy.mode, ...(confined ? { enforcement: confined.enforcement } : {}) } }
  } catch (error) {
    return errorResult(spawned ? 'RESULT_UNKNOWN' : error?.code === 'SANDBOX_UNAVAILABLE' ? 'SANDBOX_UNAVAILABLE' : 'EXECUTOR_UNAVAILABLE',
      String(error?.message ?? error), spawned ? 'unknown' : 'none')
  }
}
function runnerFailure(exitCode, stderr, rules) {
  if (exitCode === 0 || exitCode == null) return false
  return rules.some(rule => (!rule.allowedExitCodes || rule.allowedExitCodes.includes(exitCode))
    && stderr.split(/\r?\n/).some(line => !(rule.informationalLines ?? []).some(s => s.toLowerCase() === line.toLowerCase())
      && (rule.fatalSignatures ?? []).some(s => line.toLowerCase().includes(s.toLowerCase()))))
}
