#!/usr/bin/env node
/**
 * The gate runner: every `test/*.test.mjs` suite, one child process each, with
 * its own throwaway `DSH_HOME`.
 *
 * One process per file is what keeps the suites honest about global state — the
 * plugin reads `DSH_HOME`, the platform, and the tool registry from the process
 * it runs in — and a per-file home means a suite that provisions a runtime
 * cannot observe another suite's leftovers.
 *
 * THREE OUTCOMES, NOT TWO. A suite that cannot answer in this environment exits
 * with {@link SKIPPED_EXIT} (`skipSuite` in `test/lib/harness.mjs`) and is
 * counted as skipped, never as passed: a machine without a FastCtx build must
 * not be able to report a green runtime gate. `DSH_OPS_REQUIRE_RUNTIME=1` turns
 * such a skip into a failure here as well as in the suite, so the integration
 * job cannot silently lose the thing it exists to test.
 *
 * @module dsh-ops/test/run
 */

import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The exit code a suite uses to say "I skipped myself on purpose". Kept in step
 * with `SUITE_SKIPPED_EXIT` in `test/lib/harness.mjs`, which owns the protocol;
 * this runner deliberately imports nothing from the suites so that a gate can
 * still run when a suite's own dependencies cannot be resolved.
 */
const SKIPPED_EXIT = 77

const testDir = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(testDir, '..')

/**
 * The suites to run: every `*.test.mjs`, in name order, or the ones named on the
 * command line.
 * @returns {string[]} absolute suite paths.
 */
function suites() {
  const requested = process.argv.slice(2)
  const all = readdirSync(testDir)
    .filter((name) => name.endsWith('.test.mjs'))
    .sort()
  const selected = requested.length === 0
    ? all
    : all.filter((name) => requested.some((filter) => name.includes(filter)))
  return selected.map((name) => path.join(testDir, name))
}

const selected = suites()
if (selected.length === 0) {
  console.error('dsh-ops test: no suites matched')
  process.exit(1)
}

let failed = 0
let skipped = 0
const requireRuntime = process.env.DSH_OPS_REQUIRE_RUNTIME === '1'
const started = Date.now()

for (const suite of selected) {
  const home = mkdtempSync(path.join(tmpdir(), 'dsh-ops-test-home-'))
  const label = path.basename(suite)
  console.log(`\n=== ${label}`)
  const child = spawn(process.execPath, [suite], {
    cwd: root,
    env: { ...process.env, DSH_HOME: home },
    stdio: 'inherit',
  })
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    console.error(`--- ${label} exceeded the 120s suite deadline; stopping its owned process tree`)
    if (process.platform === 'win32') {
      spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', timeout: 10000 })
    } else child.kill('SIGKILL')
  }, 120000)
  const status = await new Promise(resolve => {
    child.once('error', error => { console.error(String(error)); resolve(null) })
    child.once('close', code => resolve(code))
  })
  clearTimeout(timer)
  rmSync(home, { recursive: true, force: true })
  if (status === SKIPPED_EXIT && !timedOut) {
    if (requireRuntime) {
      // A skip is the suite's way of saying "this environment cannot answer".
      // When the caller has said the runtime is required, that is a failure —
      // at both layers, so neither one alone can turn it back into a pass.
      failed += 1
      console.error(`--- ${label} skipped while DSH_OPS_REQUIRE_RUNTIME=1`)
      continue
    }
    skipped += 1
    console.log(`--- ${label} skipped`)
    continue
  }
  if (status !== 0 || timedOut) {
    failed += 1
    console.error(`--- ${label} exited ${status}${timedOut ? ' (timeout)' : ''}`)
  }
}

const seconds = Math.round((Date.now() - started) / 1000)
const passed = selected.length - failed - skipped
const skipNote = skipped === 0 ? '' : `, ${skipped} skipped`
if (failed === 0) {
  console.log(`\ndsh-ops test: ${passed} suite(s) passed${skipNote} in ${seconds}s`)
  process.exit(0)
}
console.error(`\ndsh-ops test: ${failed} of ${selected.length} suite(s) failed${skipNote} in ${seconds}s`)
process.exit(1)
