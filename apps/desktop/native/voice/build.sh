#!/bin/sh
# Builds ShrikeVoice.app (its own bundle so macOS asks for the mic in its name), ad-hoc signed.
# SwiftPM release build, plus MLX's Metal kernels as mlx.metallib next to the binary (SwiftPM can't compile .metal).
set -e
cd "$(dirname "$0")"
swift build -c release --disable-sandbox --disable-dependency-cache -debug-info-format none -q
rel=.build/release
mlx=.build/checkouts/mlx-swift/Source/Cmlx/mlx
k=$mlx/mlx/backend/metal/kernels
if [ ! -f $rel/mlx.metallib ] || [ -n "$(find $k -newer $rel/mlx.metallib -name '*.metal' | head -1)" ]; then
  air=$(mktemp -d)
  find $k -name '*.metal' ! -name '*_nax.metal' | xargs -P 8 -I{} sh -c \
    'xcrun -sdk macosx metal -x metal -std=metal3.2 -mmacosx-version-min=15.0 -g0 -fno-fast-math -Wno-c++17-extensions -Wno-c++20-extensions -c "$1" -I"$2" -I"$3" -o "$4/$(echo "$1" | shasum | cut -c1-16).air"' _ {} $k $mlx $air
  xcrun -sdk macosx metallib $air/*.air -o $rel/mlx.metallib
  rm -rf $air
fi
app=build/ShrikeVoice.app
tmp=build/.ShrikeVoice.app
rm -rf $tmp
mkdir -p $tmp/Contents/MacOS
cp Info.plist $tmp/Contents/Info.plist
cp $rel/ShrikeVoice $tmp/Contents/MacOS/
ln $rel/mlx.metallib $tmp/Contents/MacOS/mlx.metallib # hard link: 100MB of kernels, once on disk
# ponytail: ad-hoc signed with an identifier-only requirement so a rebuild keeps the mic grant; a real Developer ID cert is the upgrade.
codesign -s - -f $tmp/Contents/MacOS/mlx.metallib 2>/dev/null
codesign -s - -f -i dev.shrike.voice -r='designated => identifier "dev.shrike.voice"' $tmp 2>/dev/null
rm -rf $app
mv $tmp $app
echo "built $(pwd)/$app"
