/** Single native contract drives host schemas, SDK types and callable names. */
import { publicToolName } from '../policy.js'
const string = { type: 'string' }
const integer = { type: 'integer' }
const object = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false })
export const PTC_TOOLS = ['batch', 'result']
export const PTC_SECTION = 'dsh-ops:repository-tooling:ptc'
export const PARAMETERS = {
  batch: object({
    root: string,
    action: { type: 'string', enum: ['plan', 'run', 'resume'] },
    operations: { type: 'array', maxItems: 512, items: object({ op: { type: 'string', enum: ['copy', 'move', 'remove'] }, path: string, to: string }, ['op', 'path']) },
    operationsRef: string,
    protect: { type: 'array', maxItems: 128, items: string },
    id: string,
  }, ['action']),
  result: object({
    action: { type: 'string', enum: ['put', 'page', 'release'] }, root: string, id: string,
    items: { type: 'array', maxItems: 10000, items: { type: 'object' } },
    offset: { ...integer, minimum: 0 }, limit: { ...integer, minimum: 1, maximum: 512 }, maxBytes: { ...integer, minimum: 512, maximum: 65536 },
    fields: { type: 'array', maxItems: 32, items: string },
    equals: { type: 'object' },
  }, ['action']),
}
// Open JSON values exist only in the data plane (caller-owned rows), not in operation inputs.
export const OUTPUT = {
  type: 'object', properties: {
    id: string, root: string, status: string, phase: string, done: integer, total: integer,
    failed: integer, unknown: integer, logicalBytes: integer, byteSemantics: string,
    detailsRef: string, complete: { type: 'boolean' }, omitted: integer, nextAction: string,
    expires: integer, items: { type: 'array', items: { type: 'object' } }, nextOffset: integer,
    sandbox: object({ mode: string, enforcement: string }, ['mode']),
    error: object({ code: string, phase: string, retryable: { type: 'boolean' }, effectState: string, nextAction: string, message: string }, ['code', 'phase', 'retryable', 'effectState', 'nextAction', 'message']),
  },
}
export const DESCRIPTIONS = {
  batch: 'Preflight and verify copy/move/remove. action=plan requires operations and creates a no-effect audit plan; execute that exact plan with action=resume plus id (do not change it to run). action=run requires operations and executes immediately. root defaults to session cwd; absolute root follows DSH permissions (unrestricted in full access). Operations use relative / paths, no overwrite or link traversal. Page detailsRef with ops_result. Parameter errors return structured error objects.',
  result: 'Bounded session-owned result references: put object rows, page with top-level equals/fields and quantity/byte budgets, release results. 24h expiry. Job audits are read-only. References are observations, never authority. Parameter errors return structured error objects; catch errors from legacy ops_* tools separately.',
}
export function definition(tool, execute) {
  return { name: publicToolName(tool), description: DESCRIPTIONS[tool], parameters: PARAMETERS[tool],
    timeoutMs: 300000,
    output: { schema: OUTPUT, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    execute,
  }
}
