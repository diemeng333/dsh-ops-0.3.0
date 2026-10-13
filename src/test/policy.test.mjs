/** Current component routing: advertise only tools actually visible to the model. */
import { BASH_TOOL, FILE_TOOLS, BACKGROUND_TOOLS, TOOLING_SECTION, HOST_SHELL_SECTION,
  TOOL_PREFIX, publicToolName, renderToolingPolicy, renderHostShellPolicy,
  ladderLevels, hostShellRefusal, hostShellEnforcement } from '../lib/policy.js'
import { assert, report, test } from './lib/harness.mjs'
const files = FILE_TOOLS.map(publicToolName)
const background = BACKGROUND_TOOLS.map(publicToolName)
await test('an empty registry produces no tooling guidance', () => {
  assert.equal(renderToolingPolicy({ published: [] }), '')
})
await test('file guidance names exactly the available file tools', () => {
  const text = renderToolingPolicy({ published: files, shellComponent: false })
  assert.match(text, /^# Repository file tools/)
  for (const name of files) assert.ok(text.includes(name))
  for (const name of [BASH_TOOL, ...background, 'ops_run', 'PowerShell 7']) assert.equal(text.includes(name), false)
  assert.match(text, /Every file tool has one `path`/)
  assert.equal(text.includes('Legacy ops_* file paths are absolute'), false)
  assert.equal(text.includes('FastCtx’s own session cwd'), false)
  assert.match(text, /do not switch to a shell workaround/)
  assert.match(text, /pass only declared fields/)
})
await test('partial tool availability never advertises missing tools', () => {
  const text = renderToolingPolicy({ published: [files[0]] })
  assert.ok(text.includes(files[0]))
  for (const name of files.slice(1)) assert.equal(text.includes(name), false)
})
await test('shell routing prefers bash and names bundled pwsh only when available', () => {
  const text = renderToolingPolicy({ published: [BASH_TOOL, 'pwsh'], pwsh7: true })
  assert.match(text, /^# Shell routing: bash → PowerShell 7/)
  assert.match(text, /bundled PowerShell 7 via host/)
  assert.match(text, /fix bash errors in bash, do not switch shells/)
  assert.match(text, /longer than about 1 KB.*script_path/)
  assert.equal(renderToolingPolicy({ published: ['pwsh'] }).includes('bundled PowerShell'), false)
  assert.equal(renderToolingPolicy({ published: ['pwsh'], shellComponent: false }), '')
})
await test('background guidance includes only published owned jobs', () => {
  const text = renderToolingPolicy({ published: background, shellComponent: false })
  for (const name of background) assert.ok(text.includes(name))
  assert.match(text, /Only operate on job IDs you started in this session/)
  assert.equal(text.includes('ops_run |'), false)
  assert.equal(text.includes(BASH_TOOL), false)
})
await test('levels are registry facts, never just resolved executables', () => {
  assert.deepEqual(ladderLevels({ published: [], pwsh: true }), { fastctx: false, run: false, bash: false, pwsh: false })
  assert.deepEqual(ladderLevels({ published: [files[0], BASH_TOOL, 'pwsh'], pwsh: true }),
    { fastctx: true, run: false, bash: true, pwsh: true })
})
await test('deployment guidance is appended and transport vocabulary stays hidden', () => {
  const text = renderToolingPolicy({ published: files, extraGuidance: 'Never edit vendor/.' })
  assert.ok(text.endsWith('Never edit vendor/.'))
  assert.equal(text.includes('mcp__'), false)
  assert.equal(TOOL_PREFIX, 'ops_')
  assert.equal(BASH_TOOL, publicToolName('bash'))
})
await test('explicit deny refuses only configured names even without ops commands', () => {
  const denied = new Set(['pwsh', 'bash'])
  for (const toolName of denied) {
    const result = hostShellRefusal({ toolName, denied })
    assert.equal(result.kind, 'deny')
    assert.match(result.reason, /operator policy change/)
  }
  for (const toolName of ['read', 'edit', BASH_TOOL]) assert.equal(hostShellRefusal({ toolName, denied }), undefined)
  for (const levels of [{}, { bash: false }, { bash: true }]) {
    assert.deepEqual(hostShellEnforcement({ shellPolicy: 'deny-host-shell', levels }), { hide: true, reason: undefined })
    assert.deepEqual(hostShellEnforcement({ shellPolicy: 'advise', levels }), { hide: false, reason: undefined })
  }
})
await test('legacy second section is retired; component section prefix stays stable', () => {
  assert.equal(renderHostShellPolicy(), '')
  assert.equal(HOST_SHELL_SECTION, 'dsh-ops:host-shell-policy')
  assert.equal(TOOLING_SECTION, 'dsh-ops:repository-tooling')
})
report('policy')
