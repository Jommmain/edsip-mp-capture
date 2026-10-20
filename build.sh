#!/usr/bin/env bash
# Build dist/edsip-mp-capture-<version>.zip with extension files at the zip root.
set -euo pipefail
cd "$(dirname "$0")"
V="$(python3 -c 'import json;print(json.load(open("manifest.json"))["version"])')"
for f in *.js tests/*.js; do node --check "$f"; done
node tests/parsers.test.js && node tests/background.test.js
mkdir -p dist && rm -f "dist/edsip-mp-capture-$V.zip"
python3 - "$V" <<'PY'
import sys, zipfile
fs = "manifest.json page_hook.js content.js background.js parsers.js popup.html popup.css popup.js README.md icons/icon16.png icons/icon32.png icons/icon48.png icons/icon128.png".split()
with zipfile.ZipFile(f"dist/edsip-mp-capture-{sys.argv[1]}.zip", "w", zipfile.ZIP_DEFLATED) as z:
    for f in fs: z.write(f)
PY
echo "dist/edsip-mp-capture-$V.zip"
