/** Update configuration modification area.
 * Append migrations here; never spread upgrade write-back across components.
 * Markers belong to each owning config row, not a machine-global sentinel.
 */
export const CONFIG_UPDATE_VERSION = 1

// 0.2.5: retire the old implicit system-bash opt-in exactly once per row.
export function updatedConfig(raw = {}, disableEvaluatedFallback = false) {
  if (Number.isSafeInteger(raw?.configUpdateVersion) && raw.configUpdateVersion >= CONFIG_UPDATE_VERSION) return raw
  return { ...raw, ...(raw?.allowSystemShellFallback === true || disableEvaluatedFallback
    ? { allowSystemShellFallback: false } : {}), configUpdateVersion: CONFIG_UPDATE_VERSION }
}

const OWN_NAMES = new Set(['dsh-ops', 'dsh-ops/shell', 'dsh-ops/file', 'dsh-ops/background'])
const pending = new WeakSet()

/** Save only this component's raw owning row via the public loader lifecycle.
 * Runtime migration happens synchronously in apply before any executor resolves.
 * Write-back is deferred so Entry._init has assigned its owning fiber first.
 * Raw expressions/unrelated fields are preserved rather than serializing the
 * interpolated runtime config. The owning raw row is updated directly and the
 * tree write is scheduled; deliberately do not call Entry.update(), because
 * that needlessly remounts the plugin while the profile is loading and makes
 * every component migration compete with desktop profile reload.
 */
export function mountConfigUpdates(ctx, raw) {
  if ((raw?.configUpdateVersion ?? 0) >= CONFIG_UPDATE_VERSION) return
  const entry = ctx.fiber?.entry
  if (!entry || !OWN_NAMES.has(entry.options?.name) || typeof entry.update !== 'function'
    || typeof entry.parent?.tree?.write !== 'function') {
    ctx.logger?.warn?.('dsh-ops: config update 1 applied in memory only; no owning loader row is available for save.')
    return
  }
  if (pending.has(entry)) return
  pending.add(entry)
  let cancelled = false
  const immediate = setImmediate(() => {
    if (cancelled) { pending.delete(entry); return }
    const previous = entry.options.config ?? {}
    const next = updatedConfig(previous, raw?.allowSystemShellFallback === true)
    if (next === previous) { pending.delete(entry); return }
    // The effective config was already resolved from `updatedConfig()` in
    // applyComponent. Mutating the owning raw row and scheduling its tree write
    // is enough to persist the marker; calling `entry.update()` here would
    // restart this plugin while the profile loader is already mounting it.
    // That restart is especially expensive when several component rows migrate
    // together, and it races the desktop profile's own reload watcher.
    void (async () => {
      try {
        entry.options.config = next
        const write = entry.parent.tree.write()
        if (write && typeof write.then === 'function') await write
        ctx.logger?.info?.('dsh-ops: config update 1 submitted to the owning loader for persistence; legacy system shell fallback disabled (if previously true).')
      } catch (error) {
        // Do not retain a success marker after a synchronous/returned write
        // failure. Runtime remains confined; the next activation retries.
        if (entry.options.config === next) entry.options.config = previous
        ctx.logger?.warn?.(`dsh-ops: config update 1 could not be saved: ${error.message}; runtime fallback remains disabled for this activation.`)
      } finally { pending.delete(entry) }
    })()
  })
  ctx.effect(() => () => { cancelled = true; clearImmediate(immediate); pending.delete(entry) }, 'dsh-ops: pending config update')
}
