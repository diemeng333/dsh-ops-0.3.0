# Vendored FastCtx — what this repository changed

Upstream provenance is in `UPSTREAM.md`. This file records every difference from
the upstream commit recorded there.

The rule this directory follows is Apache-2.0 §4(b): a modified file carries a
prominent notice that it was changed. **`src/` is not untouched.** Besides the
removals listed below, this distribution also cuts standalone-product code out of
files it keeps, and every such file carries the notice on its first line. The
deletions are the only functional change: the MCP server's tool behaviour,
protocol, output formats, and every limit value stay exactly as upstream wrote
them. `Cargo.toml`, `Cargo.lock`, `build.rs`, `tools/`, `third-party/`, and the
licence/NOTICE files are unchanged.

Three model-visible strings that named Codex — the `run_background` description,
the stale-session error, and the `apply_patch` misuse note — were reworded to be
host-neutral, and the frozen description golden in `tests/server_contract.rs` was
updated to match. No tool behaviour, schema, protocol field, or limit value
changed. Modified test files carry the same notice as modified source files.

## Removed

| Path | Why it is not part of this distribution |
| --- | --- |
| `.github/` | Upstream CI and release workflows. They build and publish upstream's npm packages and GitHub Releases; this repository publishes neither, and a workflow file that cannot run here is a broken promise rather than a feature. |
| `packages/` | Upstream's npm distribution layer: the `fastctx` launcher package, the `codex-fastctx` package, and the five `@fastctx/<platform>` binary packages. This plugin does not use upstream's launcher — the DSH plugin mounts `fastctx serve` directly through the harness MCP bridge — and a vendored copy of a published package would silently shadow the published one. The published packages are still consumed as `optionalDependencies`. |
| `scripts/` | Upstream's PowerShell release and staging scripts (`stage-npm-package.ps1`, `pack-npm-root.ps1`, `verify-release-*.ps1`, `finalize-release-assets.ps1`, `stage-release-archive.ps1`, `verify-distribution-contract.ps1`, `verify-npm-install.ps1`, `drain-test-processes.ps1`) plus `verify-launcher-lifecycle.js`. All of them exist to produce or verify the npm/GitHub-Release artifacts that were removed with `packages/` and `.github/`. |
| `src/tui/` — 9 files, 8,414 lines | The control terminal (`app`, `view`, `config`, `jobs`, `migration`, `mod`, `theme`, `update`, `budget_editor`). This distribution is a pure MCP server binary: nothing reaches a full-screen TUI, and its only entry points (`fastctx ui`, the implicit TTY mode, the update-finalize/failure hand-off) are gone with it. |
| `src/update/` — 6 files, 4,331 lines | The self-updater and upstream update detection (`check`, `cache`, `helper`, `model`, `mod`, `npm_invocation`), including the `UpdateHelper` helper binary path and the proxy/registry probes against npm. `fastctx serve` neither checks for nor installs updates; the launcher packages that consumed this were already removed. |
| `src/control/agents.rs`, `apply.rs`, `codex_config.rs`, `config_i18n.rs`, `doctor.rs`, `guard_i18n.rs`, `i18n.rs`, `job_i18n.rs`, `leftovers.rs`, `link.rs`, `processes.rs`, `provider.rs` — 12 files, 9,144 lines | The ChatGPT/Codex integration (managed AGENTS.md blocks, Codex `config.toml` writing, AGENTS-link status, installed-process discovery, stale-binary cleanup), the Apply/Unapply transaction planner, the doctor, the read-only Codex provider detection that selected the Guarded output policy, and the 17-language catalogs (including the config/job/guard catalogs). All of it exists to install or describe the standalone product; `serve` needs none of it. |
| `tests/cli_apply_golden.rs` (91 lines) | Golden output of the removed `apply` command. |
| `tests/cli_contract.rs` (551 lines) | Contract tests for `apply`, `unapply`, `status`/`doctor`, `--codex-home`, and `jobs kill` — every one of them a removed command. |
| `tests/guarded_burst_contract.rs` (55 lines) | End-to-end test of the provider-driven Guarded burst pool, whose trigger was `provider.rs`. |

### Removed from files that stay

| File | What was cut, and why |
| --- | --- |
| `src/lib.rs` | `pub mod tui;` and `pub(crate) mod update;`, and the crate doc line no longer names ChatGPT and Codex. |
| `src/main.rs` | The "dual-mode MCP, CLI, and TUI" doc line: the binary is now the MCP server plus its internal child-process entry points. |
| `src/cli/mod.rs` | The `Ui`, `Apply`, `Unapply`, `Status`, `Lang`, `Jobs`, and `UpdateHelper` subcommands, every `run_tui*` path, the TTY/implicit-TUI dispatch, `require_tty`, `confirm`, the preview/receipt printers, and the `UPDATE_FINALIZE_ENV`/`UPDATE_FAILURE_ENV` startup hooks together with the `ControlPaths::discover()` + `crate::update::cleanup_replaced_binaries` call. What remains is `serve` (still the default with no subcommand) and the internal `JobBootstrap`/`JobHost`/`JobWatch`/`RuntimeBootstrap`/`RuntimeHost` entries. |
| `src/control/mod.rs` | Module list reduced to `paths`, `settings`, `transaction`. |
| `src/control/paths.rs` | `CodexHomeSource`, `discover`, `discover_with_codex_home`, `for_home_and_codex_home`, and the `codex_dir`/`codex_config`/`codex_agents`/`codex_home_source`/`fastctx_bin_dir`/`installed_binary` fields — all of them Codex-profile or self-install state that only the deleted modules read. |
| `src/control/settings.rs` | `UpdateSettings`/`UpdateSource`/`UpdateSettingsStatus`, the `language` field and its 17-language validation, `OutputGuardSettings`, `AppliedRecord`/`ManagedFileRecord`/the whole Apply receipt, the legacy `fastedit`/`FeatureToggle` key, `load_for_startup`/`StartupSettings`/`encode_startup_normalization`/`TOOL_BUDGET_EPOCH` (the startup normaliser, which only the TUI and the CLI commands ran — the server never wrote the config file), the Status-only `job_limit_status`, `update_settings_status`, `search_parallelism_status`, and `reset_user_preferences`, plus the TUI-only `Tier::as_str`/`display_name`/`previous`/`next` and its `clap::ValueEnum` derive, and `ToolBudgetLevel::label`/`percent`/`ceiling`. |
| `src/control/transaction.rs` | `FileAction::Delete`, the `locked_binary_fallback` flag and the Windows replace-the-running-binary fallback, and `validate` (documented as Unapply-only). Every surviving caller writes files. |
| `src/session.rs` | The Codex provider detection call, the `provider: ProviderDetection` field, the `CODEX_HOME` lookup, and the `EffectiveOutput`/`EffectiveOutputMode`/`effective_output` definitions that moved here from `provider.rs`. The one test that pinned the Guarded overlay became a test of the selected-tier policy. |
| `src/budget.rs` | Nothing was cut: `GUARDED_HOST_LIMIT` (10,000) and `GUARDED_FASTCTX_BUDGET` (9,000) moved here verbatim from the deleted `control/provider.rs`, values unchanged. |
| `src/server_support.rs` | Only the guarded-accounting test's path to the budget constant (`crate::budget::GUARDED_FASTCTX_BUDGET`). The burst layer itself is unchanged. |
| `src/shell_server.rs` | The `run_background` description no longer names Codex as a restart partner. |
| `src/edit/document.rs` | The removed `atomic_replace` argument. |
| `src/edit/private_storage.rs` | `update_check_directory`, whose only caller was the update cache. |
| `src/search_parallelism.rs` | `SearchParallelismInputError` and `parse_input`, the TUI's editable CPU-limit parser, together with its test. |
| `src/shell/apply_patch_hint.rs` | The `apply_patch` misuse note points at the host's own tool instead of Codex's built-in shell. |
| `src/shell/bash.rs` | `probe_bash`, the uncached Apply-preflight probe. |
| `src/shell/jobs/admission.rs` | `advance_generation` and its `generation_path` field, which only Unapply published to invalidate older servers. |
| `src/shell/jobs/mod.rs` | The TUI tail reader (`JobTail`, `TailCursor`, `refresh_tail`), the Apply/Unapply helpers (`acquire_unapply_admission`, `kill_all_running`) and the removed `fastctx jobs kill` wrapper (`kill_for_control`), the permission-denied classification only the TUI read, and the test that drove `advance_generation`. The stale-session message no longer names Unapply or ChatGPT/Codex. |
| `src/shell/jobs/store.rs` | The incremental tail reader (`LogDelta`, `read_log_delta`, `read_legacy_spool_delta`) and its three tests; the direct and legacy log readers that `job_output` uses are untouched. |
| `src/shell/jobs/output_log.rs` | `record_end` and `log_len` (only the deleted tail reader called them). `read_range` is kept but is now `#[cfg(test)]`: the serve path reads through `read_prefix_bounded`/`read_suffix_bounded`, and the reader tests below pin index decoding through it. |
| `tests/server_contract.rs` | The frozen `run_background` description golden, updated to match `src/shell_server.rs`. |
| `tests/runtime_control_center.rs` | `runtime_guard_tightens_without_apply_and_releases_on_the_next_connection`, the test whose whole subject was the removed Guarded policy. |

## Kept deliberately

- `src/`, `tests/`, `tools/`, `third-party/`, `build.rs`, `Cargo.toml`,
  `Cargo.lock`, `deny.toml`, `about.toml`, `about.hbs`, and the licence/NOTICE
  files — the runtime and its own verification.
- The guarded-burst machinery: `context_guard::GuardedBurstPool`, the burst layer
  in `src/server_support.rs`, `SessionContext::begin_guarded_response`, and the
  `Guard`ed variant of the output-mode enum. With provider detection gone nothing
  can select Guarded, so they are inert — but they are MCP server response
  plumbing rather than a standalone-product surface, they are a byte-for-byte
  pass-through when no ticket exists (which is now always), and rewriting the
  response path would change the implementation this distribution is supposed to
  leave alone. The Guarded ceilings keep their upstream values in
  `src/budget.rs`.
- `README.md`, `README.zh-CN.md`, `CONTRIBUTING.md` — upstream's own
  documentation, unedited. They describe upstream's product, including the
  installation paths and commands this distribution does not use (the TUI, the
  updater, `apply`/`unapply`/`status`); the repository README describes this
  distribution.

## Added here

| Path | License |
| --- | --- |
| `FORK.md` (this file) | MIT — this repository's own work |
| `UPSTREAM.md` | MIT — this repository's own work |

## Not changed, and the reason that matters

The `pdf` Cargo feature is left at its upstream default (enabled), so
`inspect_local_file` can read PDF text layers and render pages exactly as
upstream does. `build.rs` downloads and verifies the pinned Pdfium artifact on
first build; passing `--no-default-features` to `cargo build` disables it at the
cost of PDF support.

## Dependencies that are now declared but unused

`Cargo.toml` and `Cargo.lock` are deliberately unchanged so `cargo build --locked`
keeps working, so these stay declared even though no remaining source file names
them. Each one was used only by a module deleted above:

`crossterm`, `ratatui` (the control terminal), `walkdir` (its file browser),
`sys_locale` (the language catalog's locale detection), and `semver`, `ureq`,
`tar`, `zip`, `flate2` (the self-updater and its npm-archive extraction).
`ureq`, `tar`, and `flate2` are still used as `[build-dependencies]` by
`build.rs`.

## If you change a file under `src/`

Add the notice Apache-2.0 §4(b) requires, in the file itself, as the very first
line:

```rust
// Modified by dsh-ops (https://github.com/T-Auto/dsh-ops): <one line saying what changed and why>.
```

and record the change in the tables above. The gate does not currently enforce
this — review does.
