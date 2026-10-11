#!/bin/sh
# Builds the Linux AppImage and .deb (docs/RELEASING.md). Usage: scripts/release/build-linux.sh [x64|arm64] [targets] [out-dir]
# Defaults: this machine's arch, "AppImage deb", ./release. Same staging as build-mac.sh, minus voice (macOS only), signing and notarisation.
# Windows: the same staging with `electron-builder --win --x64` builds the NSIS installer (apps/desktop/electron-builder.yml); not scripted or tested yet.
set -eu
repo=$(cd "$(dirname "$0")/../.." && pwd)
host=$(uname -m | sed 's/x86_64/x64/; s/aarch64/arm64/')
arch=${1:-$host}
targets=${2:-AppImage deb}
out=$(mkdir -p "${3:-$repo/release}" && cd "${3:-$repo/release}" && pwd)
stage=$out/stage
desktop=$repo/apps/desktop
dep() { node -p "require('$desktop/package.json').dependencies['$1']"; }

rm -rf "$stage" "$out/dist"
mkdir -p "$stage/extra/packages/node-agent" "$stage/extra/packages/browser-agent/dist" "$stage/extra/prompts" "$stage/extra/fixtures"

# 1. The app: renderer, main, preload (bundled), plus the drivers electron-vite leaves external.
(cd "$repo" && pnpm --filter @shrike/browser-agent build)
(cd "$desktop" && pnpm exec electron-vite build --outDir "$stage/out")
cp -R "$desktop/resources" "$stage/resources"
cat > "$stage/package.json" <<JSON
{
  "name": "shrike",
  "productName": "Shrike",
  "version": "$(node -p "require('$desktop/package.json').version")",
  "description": "The Agentic Debugging Environment",
  "author": "Sumant Tirkey <st72365@gmail.com>",
  "license": "MIT",
  "homepage": "https://github.com/SumantxD/shrike",
  "type": "module",
  "main": "out/main/index.js",
  "dependencies": {
    "pg": "$(dep pg)", "mysql2": "$(dep mysql2)", "mongodb": "$(dep mongodb)", "redis": "$(dep redis)",
    "@aws-sdk/client-dynamodb": "$(dep @aws-sdk/client-dynamodb)", "node-llama-cpp": "$(dep node-llama-cpp)"
  }
}
JSON
(cd "$stage" && NODE_LLAMA_CPP_SKIP_DOWNLOAD=true npm install --omit=dev --no-package-lock --no-audit --no-fund --loglevel=error --cpu="$arch" --os=linux)
# The CPU build is enough for the planner; the CUDA and Vulkan builds are hundreds of MB.
rm -rf "$stage"/node_modules/@node-llama-cpp/*-cuda* "$stage"/node_modules/@node-llama-cpp/*-vulkan*

# 2. Resources, laid out as in the repo (src/main/paths.ts).
cp "$repo/packages/browser-agent/dist/browser-agent.js" "$stage/extra/packages/browser-agent/dist/"
cp -R "$repo/packages/node-agent/src" "$repo/packages/node-agent/package.json" "$stage/extra/packages/node-agent/"
(cd "$stage/extra/packages/node-agent" && npm install --omit=dev --no-package-lock --no-audit --no-fund --loglevel=error)
cp -R "$repo/prompts/agent" "$repo/prompts/skills" "$repo/prompts/connect" "$stage/extra/prompts/"
rsync -a --exclude node_modules --exclude .data --exclude .shrike/issues --exclude '.shrike/skills' --exclude '.shrike/flows' --exclude '.shrike/worktrees' "$repo/fixtures/todo-app" "$stage/extra/fixtures/"
(cd "$stage/extra/fixtures/todo-app" && npm install --no-package-lock --no-audit --no-fund --loglevel=error --cpu="$arch" --os=linux)

# 3. Package. The installed Electron is reused when it matches the target; otherwise electron-builder downloads one.
electron=$(node -p "require('$desktop/node_modules/electron/package.json').version")
dist=""
[ "$(uname -s)" = Linux ] && [ "$arch" = "$host" ] && dist="-c.electronDist=$desktop/node_modules/electron/dist"
# shellcheck disable=SC2086
(cd "$desktop" && pnpm exec electron-builder --linux $targets --"$arch" --projectDir "$stage" --config "$desktop/electron-builder.yml" \
  -c.electronVersion="$electron" $dist -c.directories.output="$out/dist" --publish never)

for f in "$out"/dist/*.AppImage "$out"/dist/*.deb; do
  [ -f "$f" ] || continue
  echo "built $f"
  sha256sum "$f" 2>/dev/null || shasum -a 256 "$f"
done
