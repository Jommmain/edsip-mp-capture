#!/usr/bin/env bash
# Build dist/edsip-mp-capture-<version>.zip with extension files at the zip root.
set -euo pipefail
cd "$(dirname "$0")"
V="$(python3 -c 'import json;print(json.load(open("manifest.json"))["version"])')"
for f in *.js lib/*.js tests/*.js; do node --check "$f"; done
for t in tests/*.test.js; do node "$t"; done
mkdir -p dist && rm -f "dist/edsip-mp-capture-$V.zip"
python3 - "$V" <<'PY'
import sys, zipfile
fs = "manifest.json page_hook.js content.js background.js parsers.js popup.html popup.css popup.js options.html options.css options.js lib/saving.js lib/handles.js lib/unzip.js lib/updater.js lib/envelope.js lib/transport_post.js README.md icons/icon16.png icons/icon32.png icons/icon48.png icons/icon128.png".split()
with zipfile.ZipFile(f"dist/edsip-mp-capture-{sys.argv[1]}.zip", "w", zipfile.ZIP_DEFLATED) as z:
    for f in fs: z.write(f)
PY
( cd dist && (command -v sha256sum >/dev/null && sha256sum "edsip-mp-capture-$V.zip" || shasum -a 256 "edsip-mp-capture-$V.zip") > SHA256SUMS )
# Sign SHA256SUMS with the release key kept OUTSIDE the repo (never commit it).
KEY="${EDSIP_SIGNING_KEY:-$HOME/.config/edsip-signing/release-ed25519.pem}"
if [[ -f "$KEY" ]]; then
  openssl pkeyutl -sign -rawin -inkey "$KEY" -in dist/SHA256SUMS -out dist/SHA256SUMS.sig
  echo "signed: dist/SHA256SUMS.sig"
else
  echo "WARNING: no signing key ($KEY) — dist/SHA256SUMS.sig not created; self-update will refuse this release" >&2
fi
echo "dist/edsip-mp-capture-$V.zip"
