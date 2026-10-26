#!/usr/bin/env bash
# Puts a portable Node.js (latest LTS) in .tools/node, so the project can be built and run without installing
# Node on the system. npm's cache and Electron's downloads also stay inside .tools.
# Usage:  scripts/local-node.sh            then  scripts/npm.sh install / scripts/npm.sh start
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
tools="$root/.tools"
mkdir -p "$tools"

case "$(uname -m)" in
  x86_64) arch=x64 ;;
  aarch64|arm64) arch=arm64 ;;
  *) echo "Unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac

index="$(curl -fsSL https://nodejs.org/dist/index.json)"
# The index lists newest first; the first entry with a string "lts" field is the latest LTS.
version="$(grep -o '"version":"v[0-9.]*"[^}]*"lts":"[^"]*"' <<<"$index" | grep -oE 'v[0-9]+\.[0-9.]+' | sed -n 1p || true)"
[ -n "$version" ] || { echo "Could not find the latest Node.js LTS" >&2; exit 1; }

if [ -x "$tools/node/bin/node" ] && [ "$("$tools/node/bin/node" --version)" = "$version" ]; then
  echo "Node.js $version already in .tools/node"
  exit 0
fi

name="node-$version-linux-$arch"
tmp="$(mktemp -d "$tools/download.XXXXXX")"
trap 'rm -rf "$tmp"' EXIT

echo "Downloading $name…"
curl -fsSL "https://nodejs.org/dist/$version/$name.tar.xz" -o "$tmp/$name.tar.xz"
curl -fsSL "https://nodejs.org/dist/$version/SHASUMS256.txt" -o "$tmp/SHASUMS256.txt"
(cd "$tmp" && grep " $name.tar.xz\$" SHASUMS256.txt | sha256sum -c -)

tar -xJf "$tmp/$name.tar.xz" -C "$tmp"
rm -rf "$tools/node"
mv "$tmp/$name" "$tools/node"
echo "Node.js $version ready in .tools/node"
