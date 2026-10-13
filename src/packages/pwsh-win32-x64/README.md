# Windows x64 PowerShell runtime for dsh-ops

This package carries the complete, unmodified PowerShell 7.6.6 runtime under
`bin/`, including `bin/pwsh.exe`, companion DLLs, modules, licenses and notices.
No install scripts or PATH changes. `provenance.json` records the upstream release
and the archive/executable SHA-256 values.

The licenses and third-party notices included in the upstream runtime apply to
their respective components. This is an independent redistribution, not a Microsoft
endorsement. Installed through the target profile's dsh-ops dependency graph;
uninstall via its official profile manager. Shared npm/pnpm caches are not removed.
