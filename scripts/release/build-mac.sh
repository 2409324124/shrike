#!/bin/sh
# Builds the signed macOS arm64 .dmg (docs/RELEASING.md). Usage: scripts/release/build-mac.sh [out-dir]   (default: ./release)
# Never writes into apps/desktop/out: a running dev app keeps working.
set -eu
repo=$(cd "$(dirname "$0")/../.." && pwd)
out=$(mkdir -p "${1:-$repo/release}" && cd "${1:-$repo/release}" && pwd)
stage=$out/stage
identity="Developer ID Application: Sumant Tirkey (ZK8UX8XUW9)"
desktop=$repo/apps/desktop
dep() { node -p "require('$desktop/package.json').dependencies['$1']"; }

rm -rf "$stage" "$out/dist"
mkdir -p "$stage/extra/packages/node-agent" "$stage/extra/packages/browser-agent/dist" "$stage/extra/prompts" "$stage/extra/fixtures" "$stage/extra/apps/desktop/native/voice/build"

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
(cd "$stage" && NODE_LLAMA_CPP_SKIP_DOWNLOAD=true npm install --omit=dev --no-package-lock --no-audit --no-fund --loglevel=error)

# 2. Resources, laid out as in the repo (src/main/paths.ts).
cp "$repo/packages/browser-agent/dist/browser-agent.js" "$stage/extra/packages/browser-agent/dist/"
cp -R "$repo/packages/node-agent/src" "$repo/packages/node-agent/package.json" "$stage/extra/packages/node-agent/"
(cd "$stage/extra/packages/node-agent" && npm install --omit=dev --no-package-lock --no-audit --no-fund --loglevel=error)
cp -R "$repo/prompts/agent" "$repo/prompts/skills" "$stage/extra/prompts/"
rsync -a --exclude node_modules --exclude .data --exclude .shrike/issues --exclude '.shrike/skills' --exclude '.shrike/flows' --exclude '.shrike/worktrees' "$repo/fixtures/todo-app" "$stage/extra/fixtures/"
(cd "$stage/extra/fixtures/todo-app" && npm install --no-package-lock --no-audit --no-fund --loglevel=error)

# 3. ShrikeVoice.app: built here, then signed with the Developer ID, hardened runtime and the microphone entitlement.
"$desktop/native/voice/build.sh"
voice=$stage/extra/apps/desktop/native/voice/build/ShrikeVoice.app
ditto "$desktop/native/voice/build/ShrikeVoice.app" "$voice"
# MLX looks for mlx.metallib next to the binary: a symlink there keeps the kernels a sealed resource, not loose "code".
mkdir -p "$voice/Contents/Resources"
mv "$voice/Contents/MacOS/mlx.metallib" "$voice/Contents/Resources/"
ln -s ../Resources/mlx.metallib "$voice/Contents/MacOS/mlx.metallib"
xattr -cr "$voice"
codesign -f -s "$identity" --timestamp -o runtime --entitlements "$desktop/native/voice/entitlements.plist" "$voice"

# 4. Package and sign. electronDist: the Electron already installed, so nothing is downloaded.
electron=$(node -p "require('$desktop/node_modules/electron/package.json').version")
(cd "$desktop" && pnpm exec electron-builder --mac --arm64 --projectDir "$stage" --config "$desktop/electron-builder.yml" \
  -c.electronVersion="$electron" -c.electronDist="$desktop/node_modules/electron/dist" -c.directories.output="$out/dist" --publish never)

dmg=$(ls "$out"/dist/*.dmg)
echo "built $dmg"
shasum -a 256 "$dmg"
