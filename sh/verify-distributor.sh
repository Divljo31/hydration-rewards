#!/usr/bin/env bash
set -euo pipefail

# Usage: verify-distributor.sh <env> [root-posting key]
#
# Checks the distributor recorded in deployments/<env>/distributor.json against the chain. It needs
# no key and sends nothing:
#   1. its code is the pinned URD's byte for byte, the owner and timelock are the ones in
#      migrations/envs/<env>/distributor.env, no root is set or pending, and the deployer holds no
#      role; with a root-posting key given, that key is an updater;
#   2. its creation transaction is the pinned URD's creation code with the expected constructor
#      arguments, so its storage was written by the URD's own constructor.
# A distributor that fails either check must not be funded: deploy a new one.

ENV=${1:?Usage: verify-distributor.sh <env (prod|fork)> [root-posting key]}
UPDATER=${2:-}

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
source "$ROOT_DIR/sh/distributor-env.sh"
unset PK_HYDRATION

URD=$(node "$ROOT_DIR/tools/distributor-deployment.ts" address "$ENV")
URD_DEPLOYER=$(node "$ROOT_DIR/tools/distributor-deployment.ts" deployer "$ENV")
export URD_DEPLOYER
export URD_UPDATER="$UPDATER"

cd "$ROOT_DIR/contracts"
forge script script/DeployRewardsDistributor.s.sol --rpc-url "$RPC_HYDRATION" --sig "check(address)" "$URD" $FORGE_EVM

node "$ROOT_DIR/tools/distributor-deployment.ts" verify "$ENV"
