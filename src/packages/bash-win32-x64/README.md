# Windows x64 bash runtime for dsh-ops

This package carries the complete, unmodified PortableGit 2.56.0.2 runtime,
including GNU bash 5.3.15. The entry point is `bin/bash.exe`; all companion
executables, DLLs and runtime data are retained. No install scripts or PATH changes.

`provenance.json` records the upstream release, archive and executable SHA-256.
The included `LICENSE.txt` and component licenses under the runtime directories
apply to their respective components; the npm wrapper does not relicense them.

Installed as a dependency of the target profile's dsh-ops package. Remove dsh-ops
through the official profile manager to remove its dependency references. Shared
package-manager caches are owned by the package manager, not this package.
