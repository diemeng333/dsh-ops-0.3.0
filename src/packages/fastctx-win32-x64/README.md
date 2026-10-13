# FastCtx for Windows x64

The [FastCtx](https://github.com/yc-duan/fastctx) runtime that the
[dsh-ops](https://github.com/T-Auto/dsh-ops) DSH plugin hosts as its repository
tool surface — a local Rust server speaking MCP over stdio.

| Fact | Value |
| --- | --- |
| Entry point | `bin/fastctx.exe` |
| Platform | `win32` / `x64` |
| Version | the plugin's own version (`package.json`) |
| Licence | Apache-2.0 (`LICENSE`) |
| Upstream | https://github.com/yc-duan/fastctx |
| Built from | the fork vendored in the plugin at `vendor/fastctx` |

## How this binary was produced

`cargo build --release --locked` over `vendor/fastctx` in the plugin repository,
with the toolchain and the upstream revision recorded in `provenance.json` next
to this file. The vendored tree is a pinned snapshot of upstream `main`, minus
the distribution and CI machinery and minus the standalone control terminal,
self-updater, and Codex integration that a pure MCP server does not need;
`FORK.md` is the per-file record of those removals, and `UPSTREAM.md` records
where the snapshot was taken from.

This package is not endorsed by, not supported by, and not attributable to the
author of FastCtx. The Apache-2.0 attribution notice upstream requires is in
`NOTICE`, reproduced verbatim; `LICENSE`, `FORK.md`, `UPSTREAM.md`, and the
third-party licence inventory travel with the binary so a redistribution of it
carries the same obligations it was received under.
