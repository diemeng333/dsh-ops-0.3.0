# dsh-ops 0.3.0 — prebuilt drop-in

A ready-to-install snapshot of [T-Auto/dsh-ops](https://github.com/T-Auto/dsh-ops)
**v0.3.0**, including the compiled native Rust worker, so a second machine needs
no Rust toolchain.

Upstream's npm `latest` is still `0.2.9`. `0.3.0` exists only on the `main`
branch, and the worker is a build artifact that upstream's own `.gitignore`
excludes (`runtime/`). This repository exists to carry both.

---

## What's in here

```
dist/dsh-ops-0.3.0.tgz     the installable package, native worker included
src/                        the exact v0.3.0 source tree (commit 857f917)
checksums.txt               SHA-256 of the package
install.ps1                 Windows installer (PowerShell 7 or 5.1)
install.sh                  Linux / macOS installer
```

### Verified hashes

| Artifact | SHA-256 |
|---|---|
| `dist/dsh-ops-0.3.0.tgz` | `64514e71997454e58713dd23e1be9b570974f12b70318cd8d97f5ad985299575` |
| `runtime/win32-x64/dsh-ops-worker.exe` (inside the tgz) | `31d26d8410c54d839e16e6af44790fd55263d234326cff68277ec6a3b811067c` |

The worker was built from `native/Cargo.lock` with Rust `1.98.1`:

```
RUSTUP_TOOLCHAIN=1.98.1 cargo build --release --locked --manifest-path native/Cargo.toml
node bin/dsh-ops.mjs build-ptc
```

---

## Install

### Windows

```powershell
pwsh -File .\install.ps1
```

With the opt-in PTC component enabled:

```powershell
pwsh -File .\install.ps1 -EnablePtc
```

### Linux / macOS

```bash
./install.sh
./install.sh --enable-ptc
```

The package in `dist/` ships a **Windows x64** worker only. On Linux or macOS,
build your own worker first and the installer will pick it up:

```bash
cd src
npm install
npm run build:ptc
cd ..
./install.sh
```

### Manual install (no script)

```powershell
# Windows — the reserved `desktop` profile needs the desktop app's own CLI
& "$env:APPDATA\DSH Desktop\host-commands\desktop\generations\<generation>\bin\dsh.cmd" `
  plugin --profile desktop add "file:<repo>\dist\dsh-ops-0.3.0.tgz"
```

```bash
# Linux / macOS
dsh plugin --profile web add "file:$PWD/dist/dsh-ops-0.3.0.tgz"
```

**Restart DSH** afterwards — plugin code is loaded at boot.

---

## What 0.3.0 changes

The headline change is that the four file tools stopped being a FastCtx MCP
client and became a self-contained Rust worker.

| | 0.2.9 | 0.3.0 |
|---|---|---|
| Plugin id | `dsh-ops.fastctx` | `dsh-ops.native` |
| File backend | `fastctx.exe` over stdio MCP | `dsh-ops-worker.exe`, one stdin/stdout call |
| Platform | win32 x64 | win32 / darwin / linux, x64 / arm64 |
| Components | shell, file, background | + **ptc** (opt-in, default off) |
| New tools | — | `ops_batch`, `ops_result` (PTC only) |

`ops_run_background` / `ops_job_output` / `ops_job_list` / `ops_job_kill` stay on
FastCtx and remain behind the default-off `background` component.

### Breaking contract change

`ops_inspect_local_file` took a batch of paths in 0.2.9. In 0.3.0 every file tool
takes **one** `path`, resolved against the session cwd:

```
0.2.9   { files: [...], root: "...", ... }     ← rejects `root`/`workspace`/`cwd`/`file_path` aliases
0.3.0   { path: "src/index.js", offset: 1, limit: 200 }
```

Anything calling the old schema gets a structured `INVALID_ARGUMENT` back. The
tools also now refuse to traverse symlinks, junctions, reparse points, hidden
files, and `.git`; `replace` is rejected outright in read-only sessions and uses
a temp file + fsync + atomic rename on write.

### About the advertised 97%

Upstream measured a **97% token reduction** for the PTC toolset versus the stock
Windows standard mode (65% versus stock Linux PTC) on a fixed oneshot task. Two
things must both hold for that to apply:

1. the `dsh-ops-ptc` component is enabled — it is `disabled: true` by default,
   which is what `-EnablePtc` / `--enable-ptc` flips;
2. the session runs in **PTC-only presentation** (`ptc` agent preset), so the
   wire tool list is exactly `run_code`.

With only (1) and not (2), the component mounts and then does nothing — it
verifies presentation before registering anything, re-checks on every call, and
actively restricts `ops_batch`/`ops_result` out of native and hybrid child
scopes. Enabling it without a PTC session is inert, not harmful.

---

## Rollback

```powershell
# the profile patch is backed up automatically when you pass -EnablePtc
Copy-Item "$env:USERPROFILE\.dsh\profiles\desktop\cordis.patch.yml.pre-ptc-enable-<stamp>.bak" `
          "$env:USERPROFILE\.dsh\profiles\desktop\cordis.patch.yml" -Force

# back to the published npm release
& "<desktop cli>" plugin --profile desktop add dsh-ops@0.2.9
```

---

## Upstream test status

`node test/run.mjs` in `src/` reports **9 of 10 suites green**:

```
bin 17/17   binary 17/17   config-updates 9/9   config 6/6   lifecycle 7/7
manifest 12/12   policy 9/9   ptc 5/5   shells 48/48
mount 14/15   ← pre-existing failure, see below
```

`mount.test.mjs` fails on *"file/background share runtime, but command tools
never leak into global or restricted scopes"* — a 5 s timeout waiting for the
FastCtx-backed `ops_run_background` family to publish. The same failure is
present on upstream `v0.2.9`, so it is not a 0.3.0 regression; it concerns the
default-off background component, not the native file worker.

---

## Licenses

Upstream ships `MIT AND Apache-2.0`: everything outside `vendor/fastctx/` is MIT,
the vendored FastCtx tree is Apache-2.0. Both license files are preserved
verbatim in `src/`. This repository adds only packaging scripts.
