# Releasing

One command builds a signed macOS arm64 `.dmg`. It is signed with a Developer ID and the hardened runtime, then notarised by Apple and stapled, so it opens with no warning.

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
4. `electron-builder` with `apps/desktop/electron-builder.yml`: appId `dev.shrike.app`, icon from `apps/desktop/resources/icon.png`, entitlements `apps/desktop/resources/entitlements.mac.plist` (JIT, unsigned executable memory, microphone), `NSMicrophoneUsageDescription`, `notarize: false` (the script notarises the `.dmg` itself, see below). It uses the installed Electron (`electronDist`), so nothing big is downloaded.

Brand images (the dot bust, emblem) are JSON imported by the renderer, so they are inside `app.asar` already.

Output: `release/dist/Shrike-<version>-arm64.dmg` and the unpacked `release/dist/mac-arm64/Shrike.app`. The script prints the sha256. The version comes from `apps/desktop/package.json`.

## Check

```sh
APP=release/dist/mac-arm64/Shrike.app
codesign --verify --deep --strict --verbose=2 "$APP"     # valid on disk, satisfies its Designated Requirement
spctl -a -vvv -t exec "$APP"                             # accepted, source=Notarized Developer ID
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
gh release create v0.1.0 release/dist/Shrike-0.1.0-arm64.dmg --title "Shrike 0.1.0" --notes "First public build. Signed and notarised."
```

## Notarising

`build-mac.sh` sends the finished `.dmg` to Apple with `xcrun notarytool submit --keychain-profile shrike --wait` and staples the ticket. Store the credentials once in your keychain (never in the repo), using an app-specific password from appleid.apple.com:

```sh
xcrun notarytool store-credentials shrike --apple-id <apple id> --team-id ZK8UX8XUW9
```

`SHRIKE_SKIP_NOTARY=1` skips it for a local test build. electron-builder's own `notarize` stays off: the script notarises the final `.dmg`.

## Linux

`scripts/release/build-linux.sh [x64|arm64] [targets] [out-dir]` builds an AppImage and a `.deb` (defaults: this machine's arch, `AppImage deb`, `./release`). It stages the app exactly like the macOS build, minus the voice helper (macOS only), signing and notarisation. Run it on Linux with Node 24 and pnpm 10 (`rsync` too); on another arch or OS electron-builder downloads the matching Electron instead of reusing the installed one.

```sh
pnpm i
scripts/release/build-linux.sh x64 AppImage ./release
```

- `node-llama-cpp` installs its Linux CPU build for the target arch (`npm install --cpu --os=linux`); the CUDA and Vulkan builds are dropped. Voice is hidden off macOS, so the planner never loads; if it did and failed, it turns itself off.
- Output: `release/dist/Shrike-<version>-<arch>.AppImage` and `.deb`, with their sha256. Unsigned.
- CI (`.github/workflows/ci.yml`) builds the x64 AppImage and `.deb` on every push and pull request and keeps them as the `shrike-linux-x64` artifact.
- NixOS: the AppImage runs with `appimage-run Shrike-<version>-x64.AppImage`. To package it properly, wrap `release/dist/linux-unpacked` with nixpkgs' `electron` the way other Electron apps there do; there is no Shrike derivation yet.

## Windows

`electron-builder.yml` has an unsigned NSIS target (`Shrike-<version>-x64-setup.exe`). There is no build script yet: stage as above on Windows and run `electron-builder --win --x64` against the stage. CI typechecks and runs the unit tests on `windows-latest`; the app itself has not been run on Windows.
