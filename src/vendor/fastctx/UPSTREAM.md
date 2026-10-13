# Vendored FastCtx — provenance

This directory is a copy of the FastCtx source, taken from upstream `main`. It is
**not** a submodule and not a fork repository: it is a pinned snapshot that lives
in this repository so that the runtime this plugin hosts can be built from
source, audited, and patch-rebased without a second checkout.

## What was taken

| Fact | Value |
| --- | --- |
| Upstream | https://github.com/yc-duan/fastctx |
| License | Apache-2.0 (see `LICENSE-APACHE` and `NOTICE` in this directory) |
| Source ref | `main` |
| Source commit | `ccaa157790d02328a60786eb94ee5ad698995a5f` |
| Commit date | 2026-08-30 04:09:42 +0800 |
| Commit subject | `test(contract): update the frozen run description for the Killed terminal` |
| Cargo package | `fastctx` version `0.2.6` |
| Copied | 2026-10-08 |

The upstream release tag `v0.2.6` points at `22b40ea324a186a921dfe38c205e3ffacdf6546d`
(2026-08-23), which is an ancestor of the commit copied here. The snapshot is
therefore **newer than the released `0.2.6` tag** while still declaring package
version `0.2.6`. That is upstream's own state, not an edit made here.

The published platform packages this plugin can fall back to
(`@fastctx/win32-x64` and siblings, version `0.2.6`) are built from the tag, so a
source build and a package fallback are close but not byte-identical. The plugin
resolves the source build first when one exists, and reports which one it used.

## Why a snapshot instead of a submodule

- The runtime is a native binary; a checkout that cannot build it has to be able
  to explain exactly which source produced which executable.
- `FORK.md` next to this file records every difference from upstream, so a
  re-vendor is a diff against a documented state rather than a guess.
- Nothing here imports from the network at build time except the pinned Pdfium
  artifact `build.rs` downloads for the default `pdf` feature.

## Re-vendoring

Replacing this tree is a deliberate act:

1. Check out the intended upstream commit in a scratch clone.
2. Copy it over this directory excluding `.git/`, `.github/`, `packages/`, and
   `scripts/` — the removals `FORK.md` documents.
3. Update the table above, and re-record the removals in `FORK.md`.
4. Rebuild: `node bin/dsh-ops.mjs build --force`.
5. Re-run the gate: `npm run verify`.
