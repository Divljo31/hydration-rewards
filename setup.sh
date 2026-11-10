#!/usr/bin/env bash
# Fetches the pinned URD (with its own libraries) and the Node dependencies, then checks the pin.
set -euo pipefail
cd "$(dirname "$0")"

git submodule update --init --recursive --depth 1 contracts/lib/universal-rewards-distributor \
  || git submodule update --init --recursive contracts/lib/universal-rewards-distributor
npm ci
node tools/check-pin.ts
