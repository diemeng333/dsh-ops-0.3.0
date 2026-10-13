# Native PTC enhancement — 0.3.0 development delivery

Issues: [#3](https://github.com/T-Auto/dsh-ops/issues/3), [#8](https://github.com/T-Auto/dsh-ops/issues/8).
This component is independent of FastCtx. Existing file/shell/background components
remain unchanged backends; this is not a claim that their migration is complete.

## Runtime-bearing installation and original DSH permission linkage

Published packages must carry `runtime/<platform>-<arch>/dsh-ops-worker[.exe]`
plus checksum/version provenance for all six supported platform/architecture pairs.
The release assembler refuses an incomplete matrix; `bin/native-runtime.mjs`
stages native builds, and runtime discovery checks the installed target's receipt.
No postinstall download, ACL modification or hand-written binaryPath is required.
Source users run `npm run build:ptc` once; it builds and stages their native target
without requiring a profile override. Explicit binary selections remain authoritative.
The six-target release matrix is implemented but has not been run/published here;
this checkout currently contains a staged Windows x64 worker only.

Permission corrections supersede the original v1 notes below:

- Normal modes use the original per-call `sandboxPolicy` and `sandbox.confine`.
  Both `full` and `partial` enforcement are accepted and accurately reported,
  exactly as DSH does; Windows ACL is intentionally reported as partial.
- `read-only` can page existing references through an existing read-only shared
  lock without creating directories, records or lockfiles. Other actions are denied.
- Optional absolute `root` selects the operation/data root, not the permission
  root. `workspace-write` always confines with the original session workspace.
  `danger-full-access` uses no confinement and allows roots outside the workspace.
- No extra plugin permission system, chmod/ACL repair, self-escalation or automatic
  full-access fallback. No-follow/protection/no-overwrite are operation semantics,
  not another sandbox. Full access does not remove those integrity checks.
- Acceptance now includes original installed DSH sandbox-local and subprocess-local
  providers: real confined copy, read-only page, external-root denial and unrestricted
  external-root remove in disposable fixtures. These run on Windows x64 and pass.
  No user-workspace permissions were changed by the test.

An original `run_code` failure at `grantWrite(workspace)` happens before any SDK
call. A plugin cannot repair that by registering tools differently; npm packaging
cannot confer missing Windows security-descriptor rights. That host failure remains
a host prerequisite/blocker, not a reason to weaken the plugin's confinement.

## Native file component and release scope

The file component is now independent of FastCtx. The shipped native worker is
currently validated on Windows x64; the six-platform runtime matrix and
Linux/macOS on-platform sandbox acceptance remain release gates. Do not publish
or describe a complete cross-platform release until every advertised runtime
has a provenance receipt and its real DSH composition checks pass.

In `workspace-write`, `ops_batch`/`ops_result` mutations and new audit records
remain intentionally denied because their durable records are outside the
session workspace. Existing read-only pages are permitted only when the host
and worker can open the existing store without creating files. This is a DSH
policy boundary, not a plugin fallback condition.


```console
npm run build:ptc
npm run test:ptc
npm run verify
```

Rust >=1.88 is required. Build uses `cargo build --release --locked` against
`native/Cargo.toml`. No install scripts download binaries. On Windows, enable the
session toolchain before building; do not add multi-version toolchains to global PATH.

Enable the opt-in `dsh-ops/ptc` bundle row. Its only config keys are `required`
(default false) and an optional absolute `binaryPath`. `DSH_OPS_WORKER_BIN` can
select a build; otherwise the component uses `runtime/<platform>-<arch>/dsh-ops-worker[.exe]` before `native/target/release`.
Published packages include runtime bytes; source checkouts stage them by building. A missing worker warns and publishes nothing; `required: true`
rejects activation. No install-time compilation or download is used.
Release assembler requires every advertised target; prebuilt payloads have not
been published during this development session.

The session must already use DSH's **PTC-only** presentation. The component does
not force presentation, replace the registry, or create a REPL. It recognizes the
host's public prompt assembly (`tools:ptc-only` section plus the reserved-only wire
schema), not private `modeFor`, run_code existence alone or a guessed session key.
Standard/native and hybrid/both scopes expose neither tool nor extra prompt.
The host generates SDK declarations from the same tool schemas; no duplicate guide
or dynamic plan IDs are added to the system prefix.

### Native file-tool contract

The migrated `ops_glob`, `ops_grep`, `ops_inspect_local_file` and `ops_replace`
capabilities use one `path` resolved against the current DSH session cwd. `.`
means that cwd. In `workspace-write`, DSH rejects paths outside its workspace;
explicit external absolute paths require `danger-full-access`.

`ops_glob.pattern` and `ops_grep.glob` are arrays of include/exclude patterns;
`!` entries exclude matches. `ops_grep.pattern` and `ops_replace.pattern` are
single strings. Directory traversal skips symlink/junction/reparse entries,
hidden entries, `.git`, `.dsh-ops`, `node_modules`, `target` and `.venv` without
turning skipped children into a whole-operation failure. Root access failures
return `ACCESS_DENIED`; outside-workspace failures return `POLICY_DENIED` with
the active workspace root in the message. Results are bounded and UTF-8-first.

The native schemas deliberately do not expose `root`, `workspace`, `cwd`, or
`file_path` aliases. `ops_bash` accepts the host-compatible optional
`description` field but remains foreground-only; it does not accept
`run_in_background` or create job IDs.


The legacy `ops_glob`, `ops_grep`, `ops_inspect_local_file` and `ops_replace`
interfaces are not the new Rust PTC core. Their relative-path base is FastCtx's
own session cwd, which can be the Desktop profile directory rather than DSH's
agent workspace. For deterministic comparisons, pass absolute paths. Do not pass
`path: "."` as a workspace shorthand; the legacy server may reject it or resolve
it against the wrong cwd.

Their important fields are:

- `ops_glob`: `pattern: string[]`, optional absolute `path`;
- `ops_grep`: required regex `pattern`, optional absolute `path`, optional `glob`;
- `ops_inspect_local_file`: exactly one of `file_path` or `files`, with optional
  `offset`, `limit`, `pages`, `encoding`, `view`;
- `ops_replace`: required `path`, `pattern` and `replacement`, plus its optional
  replacement controls.

Malformed arguments from these legacy MCP tools can be raised as `ToolCallError`
instead of becoming a value. In PTC code, wrap every legacy call independently:

```ts
const safeLegacy = async (name, args) => {
  try { return { ok: true, value: await tools[name](args) } }
  catch (error) { return { ok: false, name, error: String(error) } }
};
```

`ops_batch` and `ops_result` use the new canonical structured error value instead;
they do not make legacy schemas uniform. For filesystem modifications in the
new PTC workflow, prefer `ops_batch` or host native edit/write, not legacy
`ops_replace`.

## Plan and execution semantics

`ops_batch({ action: "plan", operations })` performs preflight, persists a
no-effect manifest and returns a `detailsRef`/job id. It does **not** convert into
an executable `run` request. Execute that exact planned manifest with:

```ts
await tools.ops_batch({ action: "resume", id: plan.id });
```

`action: "run"` is a separate immediate path and requires the operations again;
`run` without operations and an id is intentionally rejected. A plan is therefore
`plan → resume`, not `plan → run`. This preserves the observed revision and
protection set instead of silently replacing the plan with new input.


### `ops_batch`

```ts
const result = await tools.ops_batch({
  action: "run", // plan journals without effects; resume accepts only id
  protect: ["project/main"],
  operations: [
    { op: "copy", path: "notes/source.md", to: "archive/source.md" },
    { op: "move", path: "reviews/pr-old", to: "archive/pr-old" },
    { op: "remove", path: "cache/explicitly-approved-target" }
  ]
});
console.log({status: result.status, done: result.done, failed: result.failed,
  unknown: result.unknown, detailsRef: result.detailsRef});
```

Workspace authority comes only from `sandboxPolicy.resolve({session})`.
Optional model `root` selects an absolute operation root, not new authority. Paths are **root-relative forward-slash paths** on all platforms,
including Windows (Unicode/spaces supported); absolute paths, `..`, device/stream
names and ambiguous Windows spellings are rejected rather than shell-escaped.
Destination parent directories must already exist. No overwrite, cyclic moves,
overlapping or dependent targets within a batch. No automatic selection of junk.

All items are preflighted before effects. SHA-256 content/tree snapshots guard
observations and verify copies. Linked ancestors are never traversed. Remove
unlinks leaf symlinks/junctions, not their targets. Copy/move of links or trees
containing links is intentionally rejected in v1. Linked Git worktrees (`.git`
files), special objects and nested audit stores require their owning manager.
Ordinary repositories with a `.git` directory may be explicitly operated on.
Windows readonly regular files may have their attribute cleared through a no-follow
file handle only when singly linked; no chmod of links or shared hardlinks.
Unix readonly file unlink uses native directory permissions. File mode bits are
preserved when copying; ownership, ACLs, xattrs, resource forks and directory
metadata are not promised. Move is **verified copy then delete**, not an atomic
rename: it works across filesystems but needs temporary space and additional I/O.

`operationsRef` can replace `operations` with a same-session result containing
operation rows. Reading a reference does not authorize anything: all filesystem
preflight and current DSH policy checks run again.

### `ops_result`

```ts
// Small data is better processed directly in JavaScript.
const stored = await tools.ops_result({action: "put", items: operationRows});
const batch = await tools.ops_batch({action: "run", operationsRef: stored.id});
const page = await tools.ops_result({action: "page", id: batch.detailsRef,
  offset: 0, limit: 64, maxBytes: 16384, fields: ["operation", "state", "error"]});
console.log(page.items.filter(row => row.state !== "completed"));
await tools.ops_result({action: "release", id: stored.id});
```

put stores object rows; page supports top-level equality and field selection,
not a general query language. `nextOffset`, `total`, `complete`, `omitted` are
explicit. Pages obey serialized JSON bytes (including escape/envelope allowance),
not raw text length alone. A row that cannot fit produces `OUTPUT_LIMIT`, not a
silent empty page. Complete data stays accessible through subsequent pages.

## Authority, cancellation and job ownership

Every invocation requires a calling session identity, DSH `sandboxPolicy`,
`systemPrompt`, `tools` and `subprocess`. In `workspace-write`, exact native argv
is wrapped through **`sandbox.confine`**. The original host's enforcement level
(`full` or `partial`, including Windows ACL partial) is accepted and reported.
Missing/broken confinement fails closed. There is no unconfined fallback.
`danger-full-access` intentionally bypasses confinement as the host policy defines,
and permits explicit roots outside the workspace. Policy is resolved again after
async sandbox preparation. `read-only` supports existing result pages through a
read-only shared lock and denies mutations or new records.
Approval/escalation stays with DSH; the component does not self-grant permissions.

DSH subprocess owns credential scrub, process termination and cancellation. Native
input is bounded stdin JSON, never a shell command or argv-sized path list. Unload
aborts and waits for in-flight work. Authority downgrade aborts active workers.
If host jobs/controller admission is available, batch foreground work uses that
registry's owner, cancel and progress surfaces, waits once, then removes its own
collected terminal record. Otherwise it remains a 5-minute bounded foreground call.
No second background scheduler, detached-job polling tool or cloned REPL is created.
Progress is currently preflight/settlement only, not per-file live reporting.

## Recovery and persistence

The host allocates an audit reference **before spawn**, so cancellation/output
failure still returns `detailsRef`. A reference may be absent if interruption
preceded the initial plan commit: `NOT_FOUND` is not evidence that later effects
were completed. Once execution starts, each item has a durable write-ahead
`unknown` state before any filesystem effect, and a verified settlement after it.

- `pending`: not begun;
- `completed`: verified, never executed again;
- `failed`: refused before effects; resume rechecks the original revision;
- `unknown`: may have effects; resume checks postconditions only, never retries it.

An unresolved partial copy/deletion remains unknown for manual inspection/repair.
Recovery never substitutes new targets or protections. It binds normalized root
and opened-root device/inode identity, session, original operations and observations; restart in the same session can
recover, another session is denied. Preflight is not a rollback transaction.
A missing post-delete source proves the postcondition, not who deleted it.

Records live in `<workspace>/.dsh-ops/`, outside model output. Add `.dsh-ops/` to
workspace Git ignores; do not commit sensitive audit paths/data. Access control is
the local workspace's permissions plus same-session tool fencing; the store is
**not an encrypted or tamper-proof secret vault**. A workspace owner can tamper
with records; references are not capability tokens. Capability-relative handles
and no-follow operations prevent ordinary symlink escape, but a malicious process
actively renaming mounted/open directories or changing content during an effect
is outside the stronger protected-content guarantee: the operation is not atomic.
Do not run destructive cleanup concurrently with untrusted filesystem writers.

Result records expire after 24 hours and can be released, including after expiry.
Job audits do not auto-expire or permit release through the result tool. Archive
completed job IDs only while no worker is active; never discard unresolved records.
Latest snapshots preserve all item states; older committed generations are compacted
while retaining a predecessor. File sync + generation rename persist records;
Unix also syncs the store directory. Windows power-loss durability of directory
renames is not claimed (process interruption is covered).

Budgets: 512 operations, 128 protections, 100000 scanned entries, depth 128,
10000 stored rows, 2 MiB request/record, 64 MiB store/4096 files, pages 1..512
rows and 512..65536 bytes. Quota overflow fails explicitly. Logical bytes count
paths and can double-count hardlinks; they are not physical reclaimed space.

## Verification and remaining release gates

One isolated `test/ptc.test.mjs` contains three compact scenarios plus a native
host-provider acceptance block, separate from
all `native/src` and `lib/ptc` business code:

1. Mixed temp workspace: protected main, link cleanup, readonly Git file,
   copy/move verification, collision, changed observation and interrupted audit
   recovery without repeating completed/unknown effects.
2. 1000-row lossless pagination, budgets/projection, reference-to-batch and output
   limit recovery; schema/summary byte measurements (not invented model tokens).
3. Real Cordis/tools/prompt scopes + real worker, simulated confinement/jobs:
   SDK publication, native/hybrid isolation, authority denial, interruption facts
   and unload. The simulated provider is **not** evidence of OS sandbox isolation.

Windows x64: release build, clippy `-D warnings`, full `npm run verify` and original
DSH process sandbox acceptance executed.
macOS/Linux: `cargo check --locked` passes for Linux x64
(`x86_64-unknown-linux-gnu`) and macOS arm64 (`aarch64-apple-darwin`), using the
Windows Rust toolchain's target standard libraries. These checks compile the
platform-specific code but do not link or execute binaries. Actual on-platform
run and real sandbox denial tests **still required before release**. This machine's
WSL lacks cargo/rustc/node; no WSL environment was silently installed.
No fixed token/time saving percentage, actual model-turn benchmark,
live Desktop upgrade, npm release or GitHub push is claimed.

Architecture: `native/src/{contract,paths,batch,store,results}.rs` is the shared
Rust operation core; `main.rs` is bounded single-call JSON transport;
`lib/ptc/{contract,worker,index}.js` is only DSH registration/authority/transport.
Tests do not enter published business code; FastCtx sources are untouched.
