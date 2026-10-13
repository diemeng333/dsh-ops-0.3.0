#!/usr/bin/env bash
# dsh-ops 0.3.0 installer for DSH (Linux / macOS).
#
#   ./install.sh                      install into the desktop profile
#   ./install.sh --profile web        install into another profile
#   ./install.sh --enable-ptc         also enable the opt-in PTC component
#   ./install.sh --skip-hash-check    skip package hash verification
#
# IMPORTANT: the package in dist/ ships a Windows x64 native worker. On Linux or
# macOS you must build the worker for your own target first:
#
#   cd src && npm run build:ptc
#
# then re-pack and install, or point the PTC/file component at your build via
# DSH_OPS_WORKER_BIN. This script will warn when no worker for your platform is
# present.

set -euo pipefail

PROFILE="desktop"
ENABLE_PTC=0
SKIP_HASH=0

while [ $# -gt 0 ]; do
  case "$1" in
    --profile)     PROFILE="$2"; shift 2 ;;
    --enable-ptc)  ENABLE_PTC=1; shift ;;
    --skip-hash-check) SKIP_HASH=1; shift ;;
    -h|--help)     sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

ROOT="$(cd "$(dirname "$0")" && pwd)"
PKG="$ROOT/dist/dsh-ops-0.3.0.tgz"
EXPECTED_SHA256="64514e71997454e58713dd23e1be9b570974f12b70318cd8d97f5ad985299575"
EXPECTED_VERSION="0.3.0"

info() { printf '[dsh-ops] %s\n' "$*"; }
warn() { printf '[dsh-ops] %s\n' "$*" >&2; }
fail() { printf '[dsh-ops] ERROR: %s\n' "$*" >&2; exit 1; }

[ -f "$PKG" ] || fail "package not found: $PKG"
info "package : $(basename "$PKG") ($(wc -c < "$PKG") bytes)"

if [ "$SKIP_HASH" -eq 0 ]; then
  if command -v sha256sum >/dev/null 2>&1; then
    ACTUAL="$(sha256sum "$PKG" | cut -d' ' -f1)"
  else
    ACTUAL="$(shasum -a 256 "$PKG" | cut -d' ' -f1)"
  fi
  [ "$ACTUAL" = "$EXPECTED_SHA256" ] || fail "package hash mismatch
  expected $EXPECTED_SHA256
  actual   $ACTUAL
  Re-download the repository, or pass --skip-hash-check."
  info "sha256  : OK ($ACTUAL)"
else
  warn "sha256  : SKIPPED by request"
fi

# ---- locate the DSH CLI -------------------------------------------------
DSH_CLI="${DSH_OPS_DSH_CLI:-}"
if [ -z "$DSH_CLI" ]; then
  for c in "$(command -v dsh 2>/dev/null || true)" "$HOME/.local/bin/dsh" "/usr/local/bin/dsh"; do
    [ -n "$c" ] && [ -x "$c" ] && { DSH_CLI="$c"; break; }
  done
fi
[ -n "$DSH_CLI" ] || fail "could not locate the dsh CLI. Set DSH_OPS_DSH_CLI=/path/to/dsh"
info "dsh cli : $DSH_CLI"

DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PROFILE_DIR="$DSH_HOME/profiles/$PROFILE"
[ -f "$PROFILE_DIR/package.json" ] || fail "profile '$PROFILE' is not initialised at $PROFILE_DIR"
info "profile : $PROFILE ($PROFILE_DIR)"

# ---- install ------------------------------------------------------------
FILE_SPEC="file:$PKG"
info "running : dsh plugin --profile $PROFILE add $FILE_SPEC"
"$DSH_CLI" plugin --profile "$PROFILE" add "$FILE_SPEC"

INSTALLED="$PROFILE_DIR/node_modules/dsh-ops/package.json"
[ -f "$INSTALLED" ] || fail "install finished but $INSTALLED is missing"
VERSION="$(node -e "process.stdout.write(require('$INSTALLED').version)")"
[ "$VERSION" = "$EXPECTED_VERSION" ] || fail "expected dsh-ops $EXPECTED_VERSION but found $VERSION"
info "installed: dsh-ops $VERSION"

# ---- native worker for this platform ------------------------------------
case "$(uname -s)" in
  Darwin) OS=darwin ;;
  Linux)  OS=linux ;;
  *)      OS=win32 ;;
esac
case "$(uname -m)" in
  arm64|aarch64) ARCH=arm64 ;;
  *)             ARCH=x64 ;;
esac
TARGET="$OS-$ARCH"
WORKER="$PROFILE_DIR/node_modules/dsh-ops/runtime/$TARGET/dsh-ops-worker"
[ "$OS" = win32 ] && WORKER="$WORKER.exe"

if [ -f "$WORKER" ]; then
  info "worker  : $WORKER"
else
  warn "no native worker for $TARGET at $WORKER"
  warn "Build one from source, then re-run this installer:"
  warn "  cd src && npm run build:ptc"
  warn "The file component degrades to unavailable until then; the shell component still works."
fi

# ---- PTC opt-in ---------------------------------------------------------
if [ "$ENABLE_PTC" -eq 1 ]; then
  PATCH="$PROFILE_DIR/cordis.patch.yml"
  [ -f "$PATCH" ] || fail "profile patch not found: $PATCH"
  BACKUP="$PATCH.pre-ptc-enable-$(date +%Y%m%d-%H%M%S).bak"
  cp "$PATCH" "$BACKUP"
  info "backup  : $BACKUP"

  if grep -qE '^- *id: *dsh-ops-ptc *$' "$PATCH"; then
    # Rewrite the existing block to disabled: false, keeping the 2-space indent
    # that every sibling entry uses.
    awk '
      BEGIN { skip=0 }
      /^- *id: *dsh-ops-ptc *$/ { print "- id: dsh-ops-ptc"; print "  disabled: false"; skip=1; next }
      skip==1 && /^- / { skip=0 }
      skip==1 { next }
      { print }
    ' "$PATCH" > "$PATCH.tmp" && mv "$PATCH.tmp" "$PATCH"
    info "patch   : existing dsh-ops-ptc override updated"
  else
    printf -- '- id: dsh-ops-ptc\n  disabled: false\n' >> "$PATCH"
    info "patch   : dsh-ops-ptc override appended"
  fi

  # Parse the patch back before trusting it. A malformed override would break
  # the whole profile boot, so restore the backup instead of leaving it broken.
  YAML_LIB="${DSH_YAML_LIB:-}"
  if [ -z "$YAML_LIB" ]; then
    for c in \
      "/Applications/DSH Desktop.app/Contents/Resources/app/node_modules/yaml/dist/index.js" \
      "$HOME/.dsh/profiles/$PROFILE/node_modules/js-yaml/index.js" \
      "$PROFILE_DIR/node_modules/js-yaml/index.js"
    do
      [ -f "$c" ] && { YAML_LIB="$c"; break; }
    done
  fi

  if [ -n "$YAML_LIB" ] && command -v node >/dev/null 2>&1; then
    if node -e "
      const YAML = require(process.argv[1])
      const rows = YAML.parse(require('fs').readFileSync(process.argv[2], 'utf8'))
      const row = rows.find(e => e.id === 'dsh-ops-ptc')
      process.exit(row && row.disabled === false ? 0 : 1)
    " "$YAML_LIB" "$PATCH"; then
      info "verified: patch parses and dsh-ops-ptc is disabled: false"
    else
      cp "$BACKUP" "$PATCH"
      fail "the patched file did not verify as dsh-ops-ptc disabled: false. Original restored from $BACKUP"
    fi
  else
    warn "could not parse-verify the patch (no yaml module or node found)."
    warn "Check it manually before restarting:"
    warn "  \"$DSH_CLI\" --profile $PROFILE --dump-config | grep -A2 -E '^- id: dsh-ops-ptc\$'"
  fi
  info "rollback: cp \"$BACKUP\" \"$PATCH\""
fi

echo
info "DONE. Restart DSH to load the new plugin code."
echo
echo '  Verify after restart:'
echo '    - ops_glob / ops_grep / ops_inspect_local_file / ops_replace are available'
echo '    - file operations no longer spawn a fastctx process'
if [ "$ENABLE_PTC" -eq 1 ]; then
  echo
  echo '  PTC is enabled. To reach the advertised token reduction, start a session'
  echo '  with the "ptc" agent preset so the wire presentation is PTC-only.'
fi
echo
