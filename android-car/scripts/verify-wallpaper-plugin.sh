#!/usr/bin/env bash
# WP-09 static verifier shell entry (query-only).
# Does NOT uninstall, pm clear, or disable-user.
# Tools: aapt, apksigner, zipalign — three-package static checks.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NODE_VERIFIER="${SCRIPT_DIR}/verify-wallpaper-plugin.js"

usage() {
  cat >&2 <<'EOF'
Usage:
  verify-wallpaper-plugin.sh --fixtures
  verify-wallpaper-plugin.sh --report-json <path>
  verify-wallpaper-plugin.sh --help

Packages: com.mineradio.app / com.motif.wallpaperengine / io.wallpaperengine.weclient
Provider process: :we_runtime
Official: BrowseActivity / WEWallpaperService
ABI: arm64-v8a
Cert: mineradioCallerCertSha256 allowlist must match Mineradio APK certificate sha256
Split: sort -u of split certificate sha256 must be exactly one value

Query-only: no uninstall / pm clear / disable-user.
EOF
}

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  usage
  exit 0
fi

if [[ ! -f "$NODE_VERIFIER" ]]; then
  echo "verify-wallpaper-plugin.js missing next to shell wrapper" >&2
  exit 1
fi

# Prefer project node; fall back to PATH
exec node "$NODE_VERIFIER" "$@"
