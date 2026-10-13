# Platform package skeletons

The three directories here are the **skeletons** of the platform packages this
plugin publishes, one per package, named `<kind>-<platform>-<arch>`. They are
not the same kind of package:

| Skeleton | Published as | What it carries |
| --- | --- | --- |
| `fastctx-win32-x64/` | the FastCtx package for Windows x64 | a payload: `bin/fastctx.exe`, built from `vendor/fastctx`, plus the Apache-2.0 licence and notice documents |
| `bash-win32-x64/` | the bash pin package for Windows x64 | metadata only: a pin on Git for Windows PortableGit |
| `pwsh-win32-x64/` | the pwsh pin package for Windows x64 | metadata only: a pin on PowerShell 7 |

Each skeleton holds only what is committed by hand: the package metadata, this
documentation, and — for the FastCtx package — the licence and notice documents
that must travel with the binary. **No binary is ever committed here.**

## What the build puts in each package

`scripts/build-platform-packages.mjs` writes every package to
`<dist>/stage/<kind>-<platform>-<arch>/`.

The **payload** package:

```text
fastctx-win32-x64/
├── package.json                    name and version injected, the rest from the skeleton
├── provenance.json                 source, toolchain, upstream revision, payload digest
├── bin/fastctx.exe                 the payload
├── LICENSE, NOTICE, FORK.md,       carried verbatim from vendor/fastctx, as Apache-2.0
├── UPSTREAM.md,                    requires of a redistributor
│   THIRD_PARTY_LICENSES*.md
└── README.md
```

The **pin** packages:

```text
bash-win32-x64/  (and pwsh-win32-x64/)
├── package.json                    name and version injected, the rest from the skeleton
├── provenance.json                 the pin: repository, tag, asset name, URL, sha256,
│                                   bytes, the measured unpacked size (files and bytes),
│                                   unpacked layout, entry point and its digest, licence,
│                                   copyright, and the statement that this package
│                                   forwards no upstream bytes
└── README.md
```

Two rules keep a pin a pin, and both are enforced rather than asserted:

- **The stage may contain nothing else.** After assembly the script lists every
  file in a pin package's stage and fails if any file is not one of
  `package.json`, `provenance.json`, `README.md`. `--check` re-runs the same
  test on the existing stages, so an upstream byte cannot slip into a pin
  without failing a gate.
- **The pin is data, not a copy of the digests in prose.** `provenance.json` is
  generated from the pin record — today read from `lib/shells.js` when that
  module exports a pin table or pin function, and otherwise from the measured
  fallback inside the build script, which the script announces on every run and
  `--check` prints. `--verify-upstream` re-derives each asset digest from the
  live upstream release and deletes the download again, so a stale pin is one
  command away from being caught.

## Where the names come from

**The package name lives in exactly one module.** `lib/shells.js`
(`PLATFORM_PACKAGES`) owns the shell names and therefore the scope; the FastCtx
name comes from `lib/binary.js` (`opsFastctxPackage`). The build script imports
them and never spells a name out, which is why the skeleton `package.json` files
carry neither `name` nor `version` — a re-scoped release is one edit in `lib/`,
not a search-and-replace here.

The version of a platform package is always the version of the main package
(`package.json`), injected at build time so the two can never disagree.

## Only the payload package is injected

The main package's published copy declares the FastCtx platform package as an
`optionalDependency` — injected by the build script, never in the committed
manifest, where a version nobody has published yet would make every
contributor's `npm install` a 404.

The two shell pins are published but **never injected**, because installing one
alone cannot work: a pin carries no shell, so a dependency on it would install
metadata where a deployment expects a binary. They exist for a deployment that
deliberately resolves a shell — the plugin's own provisioning path, or an
explicit install — and an install on a platform they do not cover skips them
instead of failing.
