# Published release record — 0.2.1

Exactly what this release published to the public npm registry. `npm` reports these
digests; they are the authoritative record of the bytes users receive. They are not
derived from the local `dist` directory, whose `provenance.json` is regenerated on
every build and therefore carries a different build timestamp.

| Package | Packed | Unpacked | shasum (sha1) |
| --- | ---: | ---: | --- |
| `dsh-ops@0.2.1` | 501.9 kB | 2.4 MB | `fe4fc569565e5544b1b779b90192f610de1783d3` |
| `@dsh-ops/fastctx-win32-x64@0.2.1` | 24.7 MB | 49.9 MB | `96caf16a5978f699560d05b2126a2c6f92efb08c` |
| `@dsh-ops/bash-win32-x64@0.2.1` | 161.2 MB | 411.1 MB | `8df967f0f9ac0104e327ae1e50d55036f4790121` |
| `@dsh-ops/pwsh-win32-x64@0.2.1` | 107.6 MB | 256.6 MB | `4a3cd69f68ffc616dd6d334f170bf7423e660f24` |

All four are published with public access and tag `latest`. The main package declares
the three Windows x64 runtime packages as exact `optionalDependencies`; the platform
packages were published first, so the main package never pointed at a version the
registry did not have.

## Two publishing problems this release hit

1. **Wrong credential selected.** The first attempt used a pre-existing credential in
   the operator's `~/.npmrc`, which is a different token, and npm answered `E403`
   (2FA or a granular bypass token required). The maintainer's explicitly selected
   bypass credential was accepted. The earlier local message blaming the maintainer's
   token was wrong; the error was credential selection.
2. **Hard links are rejected by the registry.** PortableGit's tree contains 84
   hardlinked paths, and npm refused the first bash upload with
   `E415 Unsupported Media Type — Hard link is not allowed`. The assembler now
   materializes every linked path as an independent file with identical bytes, which
   is why the published bash package is 161.2 MB (411.1 MB unpacked) rather than the
   136.1 MB measured before. Runtime layout and file contents are unchanged; the
   executable digests still match `lib/shells.js`.

## Distribution

- Tag `v0.2.1` and a GitHub Release with **notes only, no assets**. `v0.2.0`
  attached four tarballs and `SHA256SUMS`; npm is now the installation channel, so
  re-uploading ~290 MB of tarballs would only duplicate it.
- Repository Actions are **disabled at repository level**. Nothing runs on push,
  tag, schedule or dispatch; the tag push above triggered no workflow. `.github/workflows/`
  is kept as documentation of the intended gate and pipeline, and each file now says
  at the top that it does not run. Publication is performed from a maintainer machine.

## What was verified, and what was not

Verified by installing the published artifacts from the registry into an isolated
directory with `--ignore-scripts`:

- `resolveShells` finds both bundled shells inside the installed dependency tree;
- the installed bash reports `GNU bash, version 5.3.15(2)-release`;
- the installed pwsh reports `7.6.6`;
- `npx --yes dsh-ops@0.2.1 status --profile tui` runs and maps `tui` to `dsh-tui`;
- `install --profile tui|desktop --dry-run` selects the expected official CLI,
  including Desktop's own `resources/runtime/cli/bin/dsh.cmd`.

Not verified: a live install into a real profile, the marketplace's pnpm path and hot
reload, official uninstall behaviour, and end-to-end plugin mount inside a running
DSH session. The repository regression suites were not updated or run for this
release, and no CI gate guarded this publication.

## Licence status

The Windows payload packages redistribute complete upstream runtime trees: Git for
Windows (GPL and other licences) and PowerShell (MIT and third-party licences). Their
original licences and notices travel inside the packages, and `provenance.json`
records the upstream URL, release, byte count and SHA-256 of the archive each payload
came from. The complete corresponding-source closure for every GPL/LGPL component in
the PortableGit inventory has **not** been collected or reviewed; no written offer was
invented, and the plugin's MIT licence does not relicense the upstream components.
This is a documented, unresolved compliance item, published at the maintainer's
explicit direction.
