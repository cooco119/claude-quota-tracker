#!/bin/bash
# Bake the `quota` single-executable binary (Node SEA).
# Homebrew's node is a stub linking shared libnode and cannot host a SEA blob,
# so the official nodejs.org binary (static libnode) is downloaded and cached.
set -euo pipefail
cd "$(dirname "$0")/.."

NODE_VERSION="v25.9.0"
ARCH="$(uname -m | sed 's/x86_64/x64/;s/arm64/arm64/')"
DIST="node-$NODE_VERSION-darwin-$ARCH"
NODE_BASE="build/$DIST/bin/node"

echo "[1/6] tsc build"
npm run build >/dev/null

echo "[2/6] bundle cli -> CJS"
mkdir -p build
npx esbuild dist/cli.js --bundle --platform=node --format=cjs \
  --outfile=build/cli.cjs --log-level=error

echo "[3/6] official node binary (static libnode)"
if [ ! -f "$NODE_BASE" ]; then
  curl -fsSL "https://nodejs.org/dist/$NODE_VERSION/$DIST.tar.gz" | tar -xz -C build
fi

echo "[4/6] generate SEA blob"
"$NODE_BASE" --experimental-sea-config sea-config.json

echo "[5/6] inject into node binary copy"
rm -f build/quota
cp "$NODE_BASE" build/quota
chmod u+w build/quota
codesign --remove-signature build/quota
npx postject build/quota NODE_SEA_BLOB build/sea-prep.blob \
  --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2 \
  --macho-segment-name NODE_SEA

echo "[6/6] ad-hoc codesign"
codesign --sign - build/quota

echo "done: $(pwd)/build/quota ($(du -h build/quota | cut -f1 | tr -d ' '))"
