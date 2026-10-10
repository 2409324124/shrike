# Releasing the macOS build

One command builds a signed macOS arm64 `.dmg`. It is signed with a Developer ID and the hardened runtime but **not notarised yet**, so users open it the first time with right-click > Open.

## Needs

- macOS on Apple Silicon, Xcode (the voice helper is Swift), Node 24, pnpm 10, about 3 GB free
- The signing identity `Developer ID Application: Sumant Tirkey (ZK8UX8XUW9)` in the login keychain (`security find-identity -v -p codesigning`)
- Network: npm installs for the staged app, Apple's timestamp server

## Build

```sh
pnpm i
scripts/release/build-mac.sh ./release      # any folder; ./release is gitignored
```

What it does (all inside the output folder, never `apps/desktop/out`, so a running dev app keeps working):

1. `electron-vite build --outDir release/stage/out`, and the browser-agent bundle.
2. A staging `package.json` with only the drivers electron-vite leaves external (`pg`, `mysql2`, `mongodb`, `redis`, `@aws-sdk/client-dynamodb`, `node-llama-cpp` with its prebuilt Metal binary), installed with `npm --omit=dev`.
3. `release/stage/extra/`, copied to `Shrike.app/Contents/Resources` in the repo's layout, which `apps/desktop/src/main/paths.ts` reads when `app.isPackaged`:
   - `packages/node-agent` (source plus its Babel deps), `packages/browser-agent/dist/browser-agent.js`
   - `prompts/agent`, `prompts/skills`
   - `fixtures/todo-app` with its own `node_modules` (the sample project; copied into userData on first open)
   - `apps/desktop/native/voice/build/ShrikeVoice.app`, built by `native/voice/build.sh`, then signed with the Developer ID, hardened runtime and `native/voice/entitlements.plist` (microphone). `mlx.metallib` moves to `Contents/Resources` with a symlink beside the binary, so it is a sealed resource.
4. `electron-builder` with `apps/desktop/electron-builder.yml`: appId `dev.shrike.app`, icon from `apps/desktop/resources/icon.png`, entitlements `apps/desktop/resources/entitlements.mac.plist` (JIT, unsigned executable memory, microphone), `NSMicrophoneUsageDescription`, `notarize: false`. It uses the installed Electron (`electronDist`), so nothing big is downloaded.

Brand images (the dot bust, emblem) are JSON imported by the renderer, so they are inside `app.asar` already.

Output: `release/dist/Shrike-<version>-arm64.dmg` and the unpacked `release/dist/mac-arm64/Shrike.app`. The script prints the sha256. The version comes from `apps/desktop/package.json`.

## Check

```sh
APP=release/dist/mac-arm64/Shrike.app
codesign --verify --deep --strict --verbose=2 "$APP"     # valid on disk, satisfies its Designated Requirement
spctl -a -vvv -t exec "$APP"                             # rejected, source=Unnotarized Developer ID (expected until notarised)
codesign -d --entitlements - "$APP"
shasum -a 256 release/dist/*.dmg
```

Smoke test the packaged app (sample project, Run, the Add Todo bug, FOUND IT from a recorded Claude stream, the voice helper hearing a WAV, the planner loading). Voice parts need the models in the dev app's userData (or `SHRIKE_E2E_MODELS`); they are hard-linked, not copied.

```sh
cd apps/desktop
SHRIKE_PACKAGED_APP="$PWD/../../release/dist/mac-arm64/Shrike.app" node --test e2e/packaged.test.ts
```

## Publish

Upload the `.dmg` to a GitHub release by hand (nothing in the script pushes or uploads):

```sh
gh release create v0.1.0 release/dist/Shrike-0.1.0-arm64.dmg --title "Shrike 0.1.0" --notes "First public build. Signed, not notarised: right-click > Open the first time."
```

## Notarising later

Set `mac.notarize: true` in `apps/desktop/electron-builder.yml` and provide `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID` in the environment (never in the repo). Every binary in the sample's `node_modules` is already signed with the hardened runtime, which notarisation requires.
