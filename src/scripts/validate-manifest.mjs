#!/usr/bin/env node
/**
 * dsh-std conformance gate for this plugin package.
 *
 * Validates the package-root `dsh-plugin.json` with the pinned Community v0.15
 * parser from `@dsh-std/manifest` — not with a hand-written check — then asserts
 * the facts this repository can get wrong about itself: the manifest version
 * matching `package.json`, the declared host entry existing, the bundle patch
 * existing, the declared tool namespace matching `lib/policy.js`, every
 * prompt section the manifest advertises actually being registered by name, and
 * the display metadata the Plugin Manager reads without activating the plugin
 * (icon and locale documents) being real, package-relative, and published by the
 * `files` whitelist.
 *
 * @module dsh-ops/validate-manifest
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml } from 'yaml'
import {
  FILE_TOOLS,
  IN_PROCESS_TOOLS,
  SHELL_TOOLS,
  BACKGROUND_TOOLS,
  TOOLING_SECTION,
  TOOL_PREFIX,
  publicToolName,
  renderToolingPolicy,
} from '../lib/policy.js'
import { resolvePtcConfig } from '../lib/ptc/index.js'
import { PTC_TOOLS, definition } from '../lib/ptc/contract.js'
import { DEFAULT_SERVER_NAME, resolveConfig } from '../lib/config.js'

/** The repository root (`scripts/`'s parent). */
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/**
 * The loader's own `!!js` extension tag.
 *
 * `cordis.patch.yml` interpolates row config with `!!js` expressions, which the
 * loader evaluates (`vendor/loader/src/config/utils.ts:5-9`) and a
 * general-purpose parser does not know: the tag still resolves to its scalar
 * content either way, so declaring it changes no parsed value — it only stops
 * the parser from warning about an unresolved tag on every run. The expression
 * text reaches this gate exactly as written, and the patch's meaning is the
 * loader's business, not this script's.
 */
const LOADER_TAGS = Object.freeze([
  { tag: 'tag:yaml.org,2002:js', resolve: (value) => value },
])

/** @type {string[]} */
const failures = []
/** @type {string[]} */
const notes = []

/**
 * Record one assertion.
 * @param {boolean} condition - the assertion result.
 * @param {string} description - what was asserted.
 * @param {string} [detail] - extra context for a failure.
 * @returns {void}
 */
function check(condition, description, detail) {
  if (condition) {
    notes.push(`  ok   ${description}`)
    return
  }
  failures.push(detail === undefined ? description : `${description} — ${detail}`)
  notes.push(`  FAIL ${description}`)
}

/**
 * Read and parse one JSON document.
 * @param {string} file - the document path.
 * @returns {any} the parsed value.
 */
function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

/**
 * Whether one `files` whitelist entry publishes one package-relative path.
 *
 * npm reads an entry as a path or a glob relative to the package root; a bare
 * directory name publishes everything below it. Only the two forms this
 * repository uses are supported, and an entry that matches neither is reported
 * as not publishing.
 *
 * @param {string} entry - one `files` entry.
 * @param {string} file - the package-relative path, with `/` separators.
 * @returns {boolean} true when the entry publishes the path.
 */
function publishes(entry, file) {
  if (entry === file) return true
  if (file.startsWith(`${entry}/`)) return true
  if (!entry.includes('*')) return false
  const pattern = entry
    .split('*')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'))
    .join('[^/]*')
  return new RegExp(`^${pattern}$`, 'u').test(file)
}

/** Paths a published package must never carry: build output, fixtures, and the gates themselves. */
const UNPUBLISHABLE = /(?:^|\/)(?:target|tests?|scripts|node_modules)(?:\/|$)|(?:^|\/)\.tmp-/u

/**
 * Whether one `exports` key addresses one package subpath.
 * @param {string} key - an `exports` key such as `./locale/*.json`.
 * @param {string} subpath - the package subpath, such as `./locale/en.json`.
 * @returns {boolean} true when the key addresses the subpath.
 */
function addresses(key, subpath) {
  if (key === subpath) return true
  if (!key.includes('*')) return false
  const pattern = key
    .split('*')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'))
    .join('[^/]*')
  return new RegExp(`^${pattern}$`, 'u').test(subpath)
}

const manifestFile = path.join(PACKAGE_ROOT, 'dsh-plugin.json')
const packageFile = path.join(PACKAGE_ROOT, 'package.json')
const manifestText = fs.readFileSync(manifestFile, 'utf8')
const manifestRaw = JSON.parse(manifestText)
const pkg = readJson(packageFile)

let manifest
let projection
try {
  const { parseManifest, projectManifest } = await import('@dsh-std/manifest')
  manifest = parseManifest(manifestText, { source: 'dsh-plugin.json' })
  projection = projectManifest(manifest)
  check(true, 'dsh-plugin.json parses under the Community v0.15 parser')
} catch (error) {
  check(false, 'dsh-plugin.json parses under the Community v0.15 parser', String(error?.message ?? error))
}

if (manifest !== undefined) {
  check(
    manifest.manifestVersion === '0.15',
    'manifestVersion is 0.15',
    `got ${JSON.stringify(manifest.manifestVersion)}`,
  )
  check(
    typeof manifest.$schema === 'string' && /^[a-z][a-z0-9+.-]*:/i.test(manifest.$schema),
    '$schema is an absolute URI',
    `got ${JSON.stringify(manifest.$schema)}`,
  )
  check(
    manifest.version === pkg.version,
    'manifest version matches package.json',
    `manifest ${manifest.version} vs package ${pkg.version}`,
  )
  check(
    manifest.name === pkg.name,
    'manifest name matches package.json',
    `manifest ${manifest.name} vs package ${pkg.name}`,
  )
  check(
    manifest.license === pkg.license,
    'manifest license matches package.json',
    `manifest ${JSON.stringify(manifest.license)} vs package ${JSON.stringify(pkg.license)}`,
  )

  const entry = manifest.facets.host.entry
  check(
    fs.existsSync(path.join(PACKAGE_ROOT, entry)),
    `declared host entry exists (${entry})`,
  )
  check(
    manifest.facets.host.apiVersion === 'v1alpha1',
    'host facet declares the host activation apiVersion',
    `got ${JSON.stringify(manifest.facets.host.apiVersion)}`,
  )

  const toolContract = manifest.requires.contracts.find((contract) => contract.kind === 'Tool')
  check(
    toolContract?.apiVersion === 'tools.dsh/v1alpha1',
    'requires.contracts declares the Tool protocol coordinate',
    `got ${JSON.stringify(manifest.requires.contracts)}`,
  )
}

if (projection !== undefined) {
  const facetNames = projection.spec.facets.map((facet) => facet.name)
  check(
    facetNames.includes('host'),
    'the host projection contains the host facet',
    `facets: ${facetNames.join(', ')}`,
  )
  check(
    projection.metadata.version === pkg.version,
    'the host projection carries the package version',
    `projection ${projection.metadata.version}`,
  )
}

const patch = pkg.dsh?.bundle?.patch
check(
  typeof patch === 'string' && fs.existsSync(path.join(PACKAGE_ROOT, patch)),
  `dsh.bundle.patch exists (${String(patch)})`,
)

// The bundle patch is the mount declaration: it is read by the loader at every
// boot, so a syntax error or an unknown config key in it takes the profile down.
// Parsing it here, and running the row's config through the plugin's own
// validator, is the only place those two facts are checked together.
if (typeof patch === 'string' && fs.existsSync(path.join(PACKAGE_ROOT, patch))) {
  const patchText = fs.readFileSync(path.join(PACKAGE_ROOT, patch), 'utf8')
  let document
  try {
    document = parseYaml(patchText, { customTags: LOADER_TAGS })
    check(true, 'the bundle patch is valid YAML')
  } catch (error) {
    check(false, 'the bundle patch is valid YAML', String(error?.message ?? error))
  }

  if (document !== undefined) {
    check(Array.isArray(document), 'the bundle patch is a list of loader patch entries')
    const rows = Array.isArray(document)
      ? document.flatMap((entry) => (Array.isArray(entry?.insert) ? entry.insert : []))
      : []
    check(rows.length === 4, 'the bundle declares exactly four components')
    for (const component of ['shell', 'file', 'background', 'ptc']) {
      const row = rows.find(candidate => candidate?.name === `${pkg.name}/${component}`)
      check(row?.id === `${pkg.name}-${component}`, `the ${component} component has a stable row id`)
      if (!row) continue
      check((row.disabled === true) === ['background', 'ptc'].includes(component), `${component} has its documented enablement default`)
      try { (component === 'ptc' ? resolvePtcConfig : resolveConfig)(row.config); check(true, `${component} config is valid`) }
      catch (error) { check(false, `${component} config is valid`, String(error?.message ?? error)) }
    }
  }
}

const namespaces = Array.isArray(manifestRaw.contributes?.['x-tool-namespaces'])
  ? manifestRaw.contributes['x-tool-namespaces']
  : []
const hostedNamespace = namespaces[0]
const backgroundNamespace = namespaces[1]
if (hostedNamespace === undefined) {
  check(false, 'contributes.x-tool-namespaces declares the hosted tool namespace')
} else {
  const declared = [...hostedNamespace.tools]
  const expected = [...FILE_TOOLS]
  check(
    declared.length === expected.length && expected.every((toolName) => declared.includes(toolName)),
    'the native file namespace matches lib/file/contract.js',
    `manifest ${declared.join(',')} vs contract ${expected.join(',')}`,
  )
  check(
    hostedNamespace.serverName === 'dsh-ops',
    'the native file namespace uses dsh-ops as its owner',
    `got ${JSON.stringify(hostedNamespace.serverName)}`,
  )
  check(
    hostedNamespace.transport === 'in-process',
    'the native file namespace is in-process',
    `got ${JSON.stringify(hostedNamespace.transport)}`,
  )
  check(
    Array.isArray(backgroundNamespace?.tools)
      && backgroundNamespace.serverName === 'fastctx'
      && backgroundNamespace.tools.length === BACKGROUND_TOOLS.length
      && BACKGROUND_TOOLS.every((toolName) => backgroundNamespace.tools.includes(toolName)),
    'the optional FastCtx namespace is background-only',
    `manifest ${JSON.stringify(backgroundNamespace?.tools)} vs background ${BACKGROUND_TOOLS.join(',')}`,
  )
  check(
    hostedNamespace.publicPrefix === TOOL_PREFIX,
    `the declared namespace publishes its tools under ${TOOL_PREFIX}`,
    `got ${JSON.stringify(hostedNamespace.publicPrefix)}`,
  )
}

// The tooling policy as a deployment that resolved every rung renders it: the
// text both tool-namespace checks below are read against.
const equippedPolicy = renderToolingPolicy({
  enableShellTools: true,
  mounted: true,
  levels: { fastctx: true, bash: true, pwsh: true },
})

// Every namespace after the first describes tools this plugin registers itself
// rather than FastCtx tools, so those names are checked against
// `IN_PROCESS_TOOLS` and against the policy text that has to name them —
// never against the FastCtx tool list. Written against whatever the manifest
// declares, so the gate is green both before and after such an entry lands.
check(
  IN_PROCESS_TOOLS.every((toolName) => equippedPolicy.includes(publicToolName(toolName))),
  'the tools this plugin registers itself are named by the tooling policy',
  `policy never names ${IN_PROCESS_TOOLS.filter((name) => !equippedPolicy.includes(publicToolName(name))).map(publicToolName).join(', ')}`,
)
for (const [index, entry] of namespaces.slice(2).entries()) {
  const declared = Array.isArray(entry?.tools) ? entry.tools : []
  const identified = declared.filter((toolName) => typeof toolName === 'string'
    && IN_PROCESS_TOOLS.includes(toolName)
    && equippedPolicy.includes(publicToolName(toolName)))
  check(
    declared.length > 0 && identified.length === declared.length,
    `every tool of the namespace at index ${index + 2} is published under ${TOOL_PREFIX} by this plugin itself`,
    `declared ${JSON.stringify(entry?.tools)} vs in-process ${IN_PROCESS_TOOLS.map(publicToolName).join(', ') || '(none)'}`,
  )
}

const sections = manifestRaw.contributes?.['x-prompt-sections'] ?? []
const sectionNames = sections.map((section) => section.name)
check(
  sectionNames.length === 3 && ['file', 'shell', 'background'].every(component => sectionNames.includes(`${TOOLING_SECTION}:${component}`)),
  'the declared prompt sections match lib/policy.js',
  `declared ${sectionNames.join(', ')} vs policy ${TOOLING_SECTION}`,
)
check(
  sections.every((section) => typeof section.order === 'number' && Number.isFinite(section.order)),
  'every declared prompt section carries a numeric order',
)

// Display metadata. The Plugin Manager cards, the bundle detail rows, and the
// settings inventory render this plugin's title, description, and icon without
// activating it: the host resolves `<specifier>/locale/en.json`,
// `<specifier>/locale/<language>.json`, and `<specifier>/package.json` through
// the package's own exports, reads `meta.title`/`meta.description` from each
// locale document, and reads `icon` from the manifest. Every one of those paths
// is therefore a packaging fact — a missing locale document or a `files` entry
// that drops it silently degrades the card to the package name and the panel's
// default artwork, with no error anywhere.
const displayRows = manifestRaw.contributes?.['x-display']
const display = Array.isArray(displayRows) ? displayRows[0] : undefined
check(
  Array.isArray(displayRows) && displayRows.length === 1,
  'contributes.x-display registers exactly one display contribution',
  `got ${JSON.stringify(displayRows)}`,
)

if (display !== undefined) {
  check(
    display.icon === pkg.icon,
    'the declared icon matches package.json icon',
    `manifest ${JSON.stringify(display.icon)} vs package ${JSON.stringify(pkg.icon)}`,
  )

  /**
   * The declared icon as a package-relative path, when it is a usable one. The
   * manifest writes it as the host reads it (`./icon.svg`); `package.json`
   * `files` entries and the checks below use the bare path.
   */
  const icon = typeof display.icon === 'string' ? display.icon : undefined
  const iconPath = icon === undefined ? undefined : icon.replace(/^\.\//u, '')
  check(
    icon !== undefined && !path.isAbsolute(icon) && ['.svg', '.png'].includes(path.extname(icon).toLowerCase()),
    'the declared icon is a package-relative SVG or PNG',
    `got ${JSON.stringify(display.icon)}`,
  )

  if (iconPath !== undefined) {
    const iconFile = path.resolve(PACKAGE_ROOT, iconPath)
    const withinPackage = path.relative(PACKAGE_ROOT, iconFile)
    let iconStat
    try {
      iconStat = fs.statSync(iconFile)
    } catch {
      iconStat = undefined
    }
    check(
      iconStat?.isFile() === true && iconStat.size <= 256 * 1024,
      'the declared icon exists, is a regular file, and is at most 256 KiB',
      iconStat === undefined ? `${iconPath} is missing` : `${iconStat.size} bytes`,
    )
    check(
      withinPackage !== '' && !withinPackage.startsWith('..') && !path.isAbsolute(withinPackage),
      'the declared icon stays inside the package directory',
      `resolves to ${withinPackage}`,
    )
    if (iconStat?.isFile() === true && path.extname(iconFile).toLowerCase() === '.png') {
      const png = fs.readFileSync(iconFile)
      check(png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        && png.length >= 33 && png.toString('ascii', 12, 16) === 'IHDR'
        && png.readUInt32BE(16) > 0 && png.readUInt32BE(20) > 0,
      'the declared PNG has a valid signature and nonzero dimensions')
    }
    if (iconStat?.isFile() === true && path.extname(iconFile).toLowerCase() === '.svg') {
      const svg = fs.readFileSync(iconFile, 'utf8')
      // A card icon is inlined as a data URL and rendered on both light and dark
      // surfaces: it must carry its own monochrome ink and reach nothing outside
      // its own bytes.
      const external = /<image\b|<script\b|\bhref\s*=|\burl\(/iu.exec(svg)
      check(
        external === null,
        'the declared icon references no external resource',
        external === null ? undefined : `found ${external[0]}`,
      )
      const gradient = /<(?:linear|radial)Gradient\b|\bfilter\s*=/iu.exec(svg)
      check(
        gradient === null,
        'the declared icon paints with one theme-independent color, not a gradient',
        gradient === null ? undefined : `found ${gradient[0]}`,
      )
    }
  }

  /** The declared locale documents, as package-relative paths. */
  const locales = Array.isArray(display.locales) ? display.locales.filter((file) => typeof file === 'string') : []
  check(
    locales.includes('locale/en.json') && locales.length === display.locales?.length,
    'the declared locales name the English document every other language shares a directory with',
    JSON.stringify(display.locales),
  )

  /** Parsed display text per declared locale, keyed by path. */
  const texts = new Map()
  for (const file of locales) {
    const document = path.join(PACKAGE_ROOT, file)
    let parsed
    try {
      parsed = readJson(document)
    } catch (error) {
      check(false, `the declared locale document parses (${file})`, String(error?.message ?? error))
      continue
    }
    const title = parsed?.meta?.title
    const description = parsed?.meta?.description
    check(
      typeof title === 'string' && title.trim() !== '' && typeof description === 'string' && description.trim() !== '',
      `the declared locale document carries meta.title and meta.description (${file})`,
      JSON.stringify(parsed?.meta),
    )
    texts.set(file, { title, description })
  }

  const english = texts.get('locale/en.json')
  check(
    english?.title === display.title,
    'the declared English title is the text locale/en.json carries',
    `manifest ${JSON.stringify(display.title)} vs locale ${JSON.stringify(english?.title)}`,
  )
  check(
    english?.description === display.description,
    'the declared English description is the text locale/en.json carries',
    `manifest ${JSON.stringify(display.description)} vs locale ${JSON.stringify(english?.description)}`,
  )

  /** The locale directory the host enumerates, from the resolved English document. */
  const localeDir = path.join(PACKAGE_ROOT, 'locale')
  const onDisk = fs.existsSync(localeDir)
    ? fs.readdirSync(localeDir).filter((name) => name.endsWith('.json')).map((name) => `locale/${name}`).sort()
    : []
  check(
    onDisk.length > 0 && onDisk.every((file) => locales.includes(file)) && locales.length === onDisk.length,
    'the declared locales are the whole locale directory',
    `declared ${locales.join(', ')} vs on disk ${onDisk.join(', ')}`,
  )

  const localeExport = pkg.exports?.['./locale/*.json']
  const manifestExport = pkg.exports?.['./package.json']
  check(
    typeof localeExport === 'string' && typeof manifestExport === 'string',
    'package.json exports the locale documents and its own manifest, as the host resolves them',
    `./locale/*.json ${JSON.stringify(localeExport)}, ./package.json ${JSON.stringify(manifestExport)}`,
  )
  const exportKeys = Object.keys(pkg.exports ?? {})
  check(
    locales.every((file) => exportKeys.some((key) => addresses(key, `./${file}`)))
    && exportKeys.some((key) => addresses(key, './package.json')),
    'every document the host reads for the card is reachable through the package exports',
    `exports: ${exportKeys.join(', ')}`,
  )

  /**
   * Paths the host must be able to read after unpacking. `package.json` is not
   * listed: npm always packs it, and the check above proves the host can resolve
   * it through this package's exports.
   */
  const published = [...(iconPath === undefined ? [] : [iconPath]), ...locales]
  const uncovered = published.filter((file) => !(pkg.files ?? []).some((entry) => publishes(entry, file)))
  check(
    uncovered.length === 0,
    'the files whitelist publishes the icon and every locale document',
    `uncovered: ${uncovered.join(', ') || '(none)'}`,
  )
}

/** Payload the published package must carry, as `files` entries or paths they cover. */
const ptc = manifestRaw.contributes?.['x-components']?.find(c => c.id === 'dsh-ops-ptc')
check(ptc?.entry === 'dsh-ops/ptc' && ptc?.defaultEnabled === false, 'native PTC component is opt-in')
check(JSON.stringify(ptc?.tools) === JSON.stringify(PTC_TOOLS.map(publicToolName)), 'PTC declaration matches the generated tool contract')
check(PTC_TOOLS.every(t => definition(t, () => {}).parameters.type === 'object'), 'PTC schemas remain structured')
check(['win32', 'darwin', 'linux'].every(p => pkg.os.includes(p) && ptc?.platforms?.includes(p)), 'PTC package supports all native platform families')
const REQUIRED_ENTRIES = [
  'native/Cargo.toml',
  'native/Cargo.lock',
  'native/src',
  'lib',
  'bin',
  'cordis.patch.yml',
  'dsh-plugin.json',
  'icon.png',
  'locale',
  'LICENSE',
  'NOTICE',
  'README.md',
  'README.zh.md',
  'PROVENANCE.md',
  'CHANGELOG.md',
  'vendor/fastctx/Cargo.toml',
  'vendor/fastctx/Cargo.lock',
  'vendor/fastctx/build.rs',
  'vendor/fastctx/src',
  'vendor/fastctx/third-party',
  'vendor/fastctx/LICENSE-APACHE',
  'vendor/fastctx/NOTICE',
  'vendor/fastctx/THIRD_PARTY_LICENSES.md',
  'vendor/fastctx/THIRD_PARTY_LICENSES_RUST.md',
  'vendor/fastctx/FORK.md',
  'vendor/fastctx/UPSTREAM.md',
]
const missingEntries = REQUIRED_ENTRIES.filter((entry) => !(pkg.files ?? []).includes(entry))
check(
  missingEntries.length === 0,
  'the files whitelist names every published payload the plugin ships',
  `missing: ${missingEntries.join(', ')}`,
)

/** `files` entries that would publish build output, fixtures, or the gates. */
const unpublishable = (pkg.files ?? []).filter((entry) => UNPUBLISHABLE.test(entry))
check(
  unpublishable.length === 0,
  'the files whitelist excludes build output, test fixtures, and the gate scripts',
  `got: ${unpublishable.join(', ')}`,
)

check(
  typeof pkg.peerDependencies?.['@deepseek-ai/dsh'] === 'string',
  'the plugin declares a DSH peer range for the host compatibility gate',
)

for (const line of notes) console.log(line)
if (failures.length > 0) {
  console.error(`\nvalidate-manifest: ${failures.length} check(s) failed`)
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exitCode = 1
} else {
  console.log(`\nvalidate-manifest: all ${notes.length} checks passed`)
}
