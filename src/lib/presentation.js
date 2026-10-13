/** Compact presentation only; arguments are forwarded unchanged. */
const DESCRIPTIONS = {
  inspect_local_file: 'Read text ranges (prefer files[] batches, up to 32), known encodings, PDF text or hex. Images: use host read_image.',
  grep: 'Search contents with ripgrep; glob[] supports batched filters and ! exclusions. Use summary/count/files_with_matches to reduce output.',
  glob: 'Find paths. Prefer pattern[] batches with ! exclusions; choose paths or details output.',
  replace: 'Mechanical replacement across files; use host edit for precise changes. Check dry-run results before applying.',
  run: 'Run a bash command (not PowerShell), returning bounded output and exit status.',
  run_background: 'Start a bash job; keep the returned job ID for output and termination in this session.',
  job_output: 'Read output of a job started in this session; use after_seq for explicit continuation.',
  job_list: 'List only jobs started in this session and connection; status and pagination apply to owned jobs.',
  job_kill: 'Terminate the process tree of a job started in this session.',
}
const FIELDS = {
  file_path: 'Absolute local path, not a URI; exclusive with files.',
  path: 'Absolute local path, not a URI; omit for connection directory where optional. Reuse escaped filenames verbatim.',
  fallback_encoding: 'Directory fallback for undecodable files; never overrides BOM or valid UTF-8.',
  filter_mode: 'ignore respects .ignore only; all disables filtering. Both include hidden/.git files; neither reads Git ignores.',
  output_mode: 'Select the output shape; grep defaults to files_with_matches, glob to paths. Grep summary ignores paging.',
  head_limit: 'Maximum output entries; 0 removes this limit, not the token budget.',
  timeout_ms: 'Command process-tree timeout in milliseconds, max 240000.',
  cwd: 'Absolute working directory; omit for the FastCtx connection directory (not the calling session).',
  encoding: 'Source encoding label (e.g. gbk); omit for detection. Output is UTF-8.',
  files: 'Prefer batches: 1-32 text ranges, in order; exclusive with file_path and top-level offset/encoding/pages/pdf_mode/view. Top-level limit is a default.',
  offset: 'Continuation offset; use the returned paging marker.',
  limit: 'Maximum results/lines; read batch entries override the top-level default.',
  pages: 'PDF page range, e.g. 1-5; max 20 pages. Required for text PDFs over 10 pages.',
  pdf_mode: 'PDF text layer only; rendered images are unsupported.',
  view: 'auto selects text/PDF; hex inspects raw bytes of any file.',
  glob: 'Prefer glob[] batches; ! excludes paths.',
  context: 'Content mode: lines before and after each match.',
  job_id: 'ID returned by your own run_background in this session.',
  wait_ms: 'Wait milliseconds, max 240000; default 30000.',
  after_seq: 'Output sequence cursor; omit to use this connection\'s cursor.',
  command: 'Bash command, not PowerShell syntax.',
  login_shell: 'Use bash login shell; default true.',
}
function shorten(schema, field, tool) {
  if (Array.isArray(schema)) return schema.map(value => shorten(value, field, tool))
  if (!schema || typeof schema !== 'object') return schema
  const result = {}
  for (const [key, value] of Object.entries(schema)) {
    if (key === 'description') {
      result[key] = field === 'pattern'
        ? (tool === 'grep' || tool === 'replace' ? 'Rust regex; escape literal braces. One pattern per call.' : 'Prefer pattern[] batches; ! excludes paths.')
        : field === 'offset' ? (tool === 'inspect_local_file' ? 'Start at this 1-based line; use for continuation.' : 'Skip this many results (0-based); use for continuation.')
        : field === 'encoding' && tool === 'grep' ? 'Single-file encoding label (e.g. gbk); directories use fallback_encoding.'
        : FIELDS[field] ?? String(value).replace(/\s+/g, ' ').trim()
    } else if (key === 'properties') {
      result[key] = Object.fromEntries(Object.entries(value).map(([name, child]) => [name, shorten(child, name, tool)]))
    } else result[key] = shorten(value, field, tool)
  }
  return result
}
export function projectTool(tool) {
  const inputSchema = shorten(tool.inputSchema ?? { type: 'object', properties: {} }, '', tool.name)
  if (tool.name === 'grep') {
    // Asymmetric context remains accepted by FastCtx but is not advertised.
    delete inputSchema.properties?.before_context
    delete inputSchema.properties?.after_context
  }
  if (tool.name === 'inspect_local_file' && inputSchema.properties?.pdf_mode) inputSchema.properties.pdf_mode.enum = ['text']
  return { ...tool, description: DESCRIPTIONS[tool.name] ?? tool.description ?? '', inputSchema }
}
