/**
 * The dsh-std manifest: parsed by the pinned Community v0.15 parser, and
 * consistent with what the code actually does.
 *
 * `scripts/validate-manifest.mjs` owns the structural gate; this suite owns the
 * claim that the manifest is not a parallel fiction — every tool and section it
 * advertises must be one the policy module produces.
 */

import fs from 'node:fs'
import path from 'node:path'
import {
  BACKGROUND_TOOLS,
  FILE_TOOLS,
  HOST_SHELL_SECTION,
  IN_PROCESS_TOOLS,
  SHELL_TOOLS,
  TOOLING_SECTION,
  TOOL_PREFIX,
  publicToolName,
  renderToolingPolicy,
} from '../lib/policy.js'
import { assert, PACKAGE_ROOT, report, test } from './lib/harness.mjs'

const manifestFile = path.join(PACKAGE_ROOT, 'dsh-plugin.json')
const text = fs.readFileSync(manifestFile, 'utf8')
const raw = JSON.parse(text)
const pkg = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8'))

/** The pinned Community v0.15 parser, loaded once for the suite. */
const { parseManifest, projectManifest } = await import('@dsh-std/manifest')

await test('the manifest parses under the pinned dsh-std Community v0.15 parser', () => {
  const parsed = parseManifest(text, { source: 'dsh-plugin.json' })
  assert.equal(parsed.manifestVersion, '0.15')
  assert.equal(parsed.version, pkg.version)
})

await test('the host projection exposes the host facet at the package version', () => {
  const projection = projectManifest(parseManifest(text, { source: 'dsh-plugin.json' }))
  assert.deepEqual(projection.metadata.version, pkg.version)
  assert.ok(projection.spec.facets.some((facet) => facet.name === 'host'))
})

await test('the parser rejects a manifest whose version it does not implement', () => {
  const broken = text.replace('"manifestVersion": "0.15"', '"manifestVersion": "0.1.0"')
  assert.throws(() => parseManifest(broken, { source: 'dsh-plugin.json' }))
})

await test('$schema is an absolute URI matching the pinned manifest version', () => {
  assert.match(raw.$schema, /^https:\/\/raw\.githubusercontent\.com\/T-Auto\/dsh-std\/[0-9a-f]{40}\//)
  assert.match(raw.$schema, /dsh-plugin-0\.15\.schema\.json$/)
})

await test('every declared tool is one the policy actually names', () => {
  const namespaces = raw.contributes['x-tool-namespaces']
  // The policy as a deployment that resolved every rung renders it: a bundled
  // shell is named only when it resolved, and a level left off would hide a
  // declared tool from this check.
  const policy = renderToolingPolicy({
    enableShellTools: true,
    mounted: true,
    levels: { fastctx: true, bash: true, pwsh: true },
  })

  // Index 0 is the native file namespace. FastCtx is deliberately confined
  // to the disabled background component at index 1.
  const hosted = namespaces[0]
  assert.deepEqual(
    [...hosted.tools].sort(),
    [...FILE_TOOLS].sort(),
    'the native namespace declares exactly the four file tools',
  )
  assert.equal(hosted.transport, 'in-process')
  assert.deepEqual(
    [...namespaces[1].tools].sort(),
    [...BACKGROUND_TOOLS].sort(),
    'the optional FastCtx namespace is background-only',
  )
  for (const tool of hosted.tools) {
    assert.ok(policy.includes(publicToolName(tool)), `the policy never names ${publicToolName(tool)}`)
  }

  // Every further namespace is this plugin's own in-process surface, so its
  // names are checked against `IN_PROCESS_TOOLS` and against the policy, never
  // against the FastCtx list. Vacuously true while no such entry exists, so the
  // suite is green before and after that entry lands.
  for (const [offset, entry] of namespaces.slice(2).entries()) {
    const index = offset + 2
    assert.ok(
      Array.isArray(entry.tools) && entry.tools.length > 0,
      `the namespace at index ${index} must declare its tools`,
    )
    for (const tool of entry.tools) {
      assert.ok(
        IN_PROCESS_TOOLS.includes(tool),
        `the namespace at index ${index} declares ${tool}, which the plugin does not register itself`,
      )
      assert.ok(policy.includes(publicToolName(tool)), `the policy never names ${publicToolName(tool)}`)
    }
  }

  // The other direction: every tool this plugin registers itself is named
  // somewhere, so a new in-process tool cannot land without policy text.
  for (const tool of IN_PROCESS_TOOLS) {
    assert.ok(policy.includes(publicToolName(tool)), `the policy never names ${publicToolName(tool)}`)
  }
})

await test('the declared namespace documents the upstream names and the public prefix', () => {
  const namespace = raw.contributes['x-tool-namespaces'][0]
  // `serverName` stays the bridge's own namespace: it is what the bridge
  // reserves and what this plugin intercepts, not what the model sees.
  assert.equal(namespace.serverName, 'dsh-ops')
  assert.equal(namespace.publicPrefix, TOOL_PREFIX)
  for (const tool of namespace.tools) {
    assert.ok(publicToolName(tool).startsWith(namespace.publicPrefix))
    assert.equal(publicToolName(tool).includes('__'), false, 'the published name carries no bridge vocabulary')
  }
})

await test('the declared prompt sections are the registered ones', () => {
  const declared = raw.contributes['x-prompt-sections'].map((section) => section.name)
  assert.deepEqual([...declared].sort(), ['file', 'shell', 'background'].map(name => `${TOOLING_SECTION}:${name}`).sort())
})

await test('the manifest license states the composite this repository ships', () => {
  assert.equal(raw.license, 'MIT AND Apache-2.0')
  assert.equal(pkg.license, raw.license)
  assert.ok(fs.existsSync(path.join(PACKAGE_ROOT, 'LICENSE')))
  assert.ok(fs.existsSync(path.join(PACKAGE_ROOT, 'NOTICE')))
  assert.ok(fs.existsSync(path.join(PACKAGE_ROOT, 'vendor', 'fastctx', 'LICENSE-APACHE')))
  assert.ok(fs.existsSync(path.join(PACKAGE_ROOT, 'vendor', 'fastctx', 'NOTICE')))
})

await test('the declared host entry is the shipped module', () => {
  assert.ok(fs.existsSync(path.join(PACKAGE_ROOT, raw.facets.host.entry)))
  assert.equal(pkg.main, raw.facets.host.entry)
})

/** The display contribution the Plugin Manager reads without activating the plugin. */
const display = raw.contributes['x-display'][0]

await test('the card text is translated, not one string repeated across locales', () => {
  const read = (language) => JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'locale', `${language}.json`), 'utf8')).meta
  const english = read('en')
  const chinese = read('zh')
  assert.equal(english.title, display.title, 'the manifest and the English locale must not drift')
  assert.equal(english.title, pkg.name, 'the shared brand title is intentionally not translated')
  assert.equal(chinese.title, english.title)
  assert.notEqual(chinese.description, english.description, 'the Chinese card must not show the English description')
})

await test('the card icon is a self-contained PNG with bounded dimensions', () => {
  const icon = fs.readFileSync(path.join(PACKAGE_ROOT, display.icon))
  assert.equal(display.icon, './icon.png')
  assert.deepEqual(icon.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  assert.equal(icon.toString('ascii', 12, 16), 'IHDR')
  assert.equal(icon.readUInt32BE(16), 256)
  assert.equal(icon.readUInt32BE(20), 256)
  assert.ok(icon.length <= 256 * 1024)
})

await test('the icon and all component entries are shipped in the package whitelist', () => {
  assert.ok(pkg.files.includes('icon.png'))
  for (const component of ['shell', 'file', 'background', 'ptc']) {
    const directory = path.join(PACKAGE_ROOT, 'lib', 'components', component)
    assert.ok(fs.existsSync(path.join(directory, 'index.js')))
    assert.ok(pkg.exports[`./${component}`])
    const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'))
    assert.equal(path.isAbsolute(manifest.icon), false)
    const iconFile = fs.realpathSync(path.resolve(directory, manifest.icon))
    const relative = path.relative(fs.realpathSync(directory), iconFile)
    assert.ok(relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative), `${component}: icon must stay inside its manifest directory`)
    assert.ok(fs.statSync(iconFile).isFile() && fs.statSync(iconFile).size <= 256 * 1024)
  }
})

report('manifest')
