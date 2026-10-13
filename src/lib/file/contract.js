import { publicToolName } from '../policy.js'

const string = { type: 'string' }
const integer = { type: 'integer', minimum: 0 }
const bounded = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false })

export const FILE_TOOLS = Object.freeze(['inspect_local_file', 'grep', 'glob', 'replace'])

export const PARAMETERS = Object.freeze({
  inspect_local_file: bounded({
    path: string,
    offset: { ...integer, minimum: 1 },
    limit: { ...integer, minimum: 1, maximum: 10000 },
    encoding: { type: 'string', enum: ['utf-8'] },
    view: { type: 'string', enum: ['text', 'hex'] },
  }),
  glob: bounded({
    path: string,
    pattern: { type: 'array', minItems: 1, items: string },
    outputMode: { type: 'string', enum: ['paths', 'details'] },
    sort: { type: 'string', enum: ['path', 'modified'] },
    offset: integer,
    limit: { ...integer, minimum: 1, maximum: 10000 },
  }, ['pattern']),
  grep: bounded({
    path: string,
    pattern: string,
    glob: { type: 'array', items: string },
    outputMode: { type: 'string', enum: ['files_with_matches', 'content', 'count', 'summary'] },
    caseInsensitive: { type: 'boolean' },
    lineNumbers: { type: 'boolean' },
    beforeContext: { ...integer, maximum: 32 },
    afterContext: { ...integer, maximum: 32 },
    multiline: { type: 'boolean' },
    offset: integer,
    limit: { ...integer, minimum: 1, maximum: 10000 },
  }, ['pattern']),
  replace: bounded({
    path: string,
    pattern: string,
    replacement: string,
    glob: { type: 'array', items: string },
    maxReplacements: { ...integer, minimum: 1, maximum: 100000 },
    dryRun: { type: 'boolean' },
  }, ['pattern', 'replacement']),
})

export const OUTPUT = {
  type: 'object',
  properties: {
    status: { type: 'string' }, phase: { type: 'string' }, changed: { type: 'integer' },
    matched: { type: 'integer' }, skipped: { type: 'integer' }, failed: { type: 'integer' },
    complete: { type: 'boolean' }, omitted: { type: 'integer' }, total: { type: 'integer' },
    nextOffset: { type: 'integer' }, truncated: { type: 'boolean' }, items: { type: 'array', items: {} },
    dryRun: { type: 'boolean' }, files: { type: 'integer' }, matches: { type: 'integer' },
    error: { type: 'object' },
  },
}

export const DESCRIPTIONS = Object.freeze({
  inspect_local_file: 'Read bounded UTF-8 text lines or a hex view from path relative to the DSH session cwd. Directories are rejected; use ops_glob or ops_grep.',
  glob: 'Find regular files below path using explicit include/exclude glob patterns. Symlinks, reparse points, hidden files and .git are not traversed.',
  grep: 'Search UTF-8 files below path with Rust regex, bounded output, paging and optional line context.',
  replace: 'Perform a deterministic UTF-8 replacement under path. dryRun observes only; writes use revision checks and atomic replacement. Read-only sessions are rejected.',
})

export function definition(rawName, execute) {
  return {
    name: publicToolName(rawName),
    description: DESCRIPTIONS[rawName],
    parameters: PARAMETERS[rawName],
    ...(rawName !== 'replace' ? { isConcurrencySafe: () => true } : {}),
    output: { schema: OUTPUT, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    execute,
  }
}
