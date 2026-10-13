/**
 * The shared test harness: one named check at a time, honest exit codes, and a
 * hard refusal to run against the real DSH_HOME.
 *
 * `test(name, body)` records a pass or a failure and never throws, so a suite
 * reports every check it can instead of stopping at the first red one;
 * `report()` turns the tally into the process exit code. Zero dependencies —
 * `node:assert/strict` is the whole assertion library.
 *
 * The temporary-DSH_HOME guard is deliberately fatal: `test/run.mjs` always
 * injects one, so a suite invoked directly as `node test/x.test.mjs` must not
 * silently write the developer's real `~/.dsh/dsh-ops/`.
 *
 * @module dsh-ops/test/harness
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** The repository root, resolved from this file (`test/lib/`). */
export const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

const home = process.env.DSH_HOME ?? ''
if (home === '' || !path.resolve(home).startsWith(path.resolve(tmpdir()))) {
  console.error(
    'dsh-ops test: refusing to run with DSH_HOME pointing outside the temporary directory '
    + `(${home === '' ? 'unset' : home}). Run the suites through \`node test/run.mjs\`, which `
    + 'creates a throwaway DSH_HOME per file.',
  )
  process.exit(2)
}

/** The throwaway DSH home this suite may write into. */
export const TEST_HOME = path.resolve(home)

let failures = 0
const names = []

/**
 * Run one named check.
 * @param {string} name - the check name.
 * @param {() => unknown | Promise<unknown>} body - the check.
 * @returns {Promise<void>} resolves after the check has been recorded.
 */
export async function test(name, body) {
  names.push(name)
  try {
    await body()
    console.log(`  ok   ${name}`)
  } catch (error) {
    failures += 1
    console.error(`  FAIL ${name}\n       ${String(error?.stack ?? error).split('\n').join('\n       ')}`)
  }
}

/** The assertion library, re-exported so suites import one module. */
export { assert }

/**
 * Create a directory under the runner's temporary home that is removed when the
 * body resolves.
 * @param {string} prefix - directory-name infix, for readable leftovers.
 * @param {(dir: string) => unknown | Promise<unknown>} body - the work.
 * @returns {Promise<unknown>} whatever the body returned.
 */
export async function withTempDir(prefix, body) {
  const dir = mkdtempSync(path.join(TEST_HOME, `${prefix}-`))
  try {
    return await body(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * Create a directory that outlives the body, for a scenario the suite asserts
 * about after the fact.
 * @param {...string} segments - path segments below the temporary home.
 * @returns {string} the created directory.
 */
export function scenarioDir(...segments) {
  const dir = path.join(TEST_HOME, ...segments)
  mkdirSync(dir, { recursive: true })
  return dir
}

/** The real timers, captured before any suite swaps the globals out. */
const REAL_TIMERS = { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout }

/**
 * Wait for real time to pass, using the captured real timer.
 * @param {number} ms - milliseconds to wait.
 * @returns {Promise<void>} resolves after the delay.
 */
export const wait = (ms) => new Promise((resolve) => REAL_TIMERS.setTimeout(resolve, ms))

/**
 * Wait until a condition holds, or fail after a deadline.
 * @param {() => boolean} condition - the predicate.
 * @param {object} [options] - wait inputs.
 * @param {number} [options.timeoutMs] - how long to keep asking.
 * @param {number} [options.intervalMs] - how long to wait between asks.
 * @param {string} [options.what] - what was being waited for, for the error.
 * @returns {Promise<void>} resolves once the condition holds.
 */
export async function waitFor(condition, { timeoutMs = 30_000, intervalMs = 50, what = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (condition()) return
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`)
    await wait(intervalMs)
  }
}

/** Let every queued microtask and macrotask settle. */
export const tick = () => new Promise((resolve) => setImmediate(resolve))

/**
 * The exit code `test/run.mjs` reads as "this suite skipped itself on purpose".
 *
 * A skip is explicitly NOT a pass: the runner counts it apart from the suites
 * that ran and prints it in the summary line, and `DSH_OPS_REQUIRE_RUNTIME=1`
 * turns it into a failure both in the suite and in the runner, so an
 * environment that lacks what a suite needs can never look like a green gate.
 */
export const SUITE_SKIPPED_EXIT = 77

/**
 * Skip the whole suite, visibly, before any check has run.
 *
 * The caller decides when a suite cannot answer here — `mount.test.mjs` uses it
 * when no FastCtx runtime is resolvable — and the reason travels to the
 * summary, so "nothing ran" is never mistaken for "everything passed".
 * @param {string} label - the suite label used in the summary line.
 * @param {string} reason - why this suite cannot run in this environment.
 * @returns {never} does not return.
 */
export function skipSuite(label, reason) {
  console.log(`\ndsh-ops ${label}: skipped (${reason})`)
  process.exit(SUITE_SKIPPED_EXIT)
}

/**
 * Print the tally and set the exit code, matching what `test/run.mjs` reads back
 * from the child process.
 *
 * The backstop is deliberate: a suite whose checks all pass can still fail to
 * terminate (a leaked interval, a live child process), and a hung suite must
 * become a bounded failure rather than a stalled gate.
 * @param {string} label - the suite label used in the summary line.
 * @returns {void}
 */
export function report(label) {
  console.log(
    failures === 0
      ? `\ndsh-ops ${label}: all ${names.length} checks passed`
      : `\ndsh-ops ${label}: ${failures} of ${names.length} check(s) failed`,
  )
  process.exitCode = failures === 0 ? 0 : 1
  process.once('beforeExit', () => process.exit(failures === 0 ? 0 : 1))
  REAL_TIMERS.setTimeout(() => {
    console.error(`dsh-ops ${label}: did not terminate after report(); forcing exit (leaked handle?)`)
    process.exit(1)
  }, 5_000).unref?.()
}
