#!/usr/bin/env bash
set -euo pipefail

# Usage: migrate-distributor.sh <env>
#
# Deploys the rewards distributor (Morpho's Universal Rewards Distributor, pinned and unmodified) on
# Hydration, checks the deployment, and records it in deployments/<env>/distributor.json.
# Settings come from migrations/envs/<env>/distributor.env. Run it against the fork first:
#   npm run fork:hydration
#   npm run migrate:distributor:fork
#
# Required env vars:
#   PK_HYDRATION  Hydration deployer (0x...), with an EVMAccounts.ContractDeployer slot

ENV=${1:?Usage: migrate-distributor.sh <env (prod|fork)>}

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
source "$ROOT_DIR/sh/distributor-env.sh"

if [ "$ENV" = "fork" ]; then
  # anvil's first account
  PK_HYDRATION=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
elif [ -e "$STATE" ]; then
  # A deployment record is written once. A second distributor would split the claims.
  echo "Already deployed: $STATE. Move the record aside to deploy another distributor." >&2
  exit 1
fi

PK_HYDRATION=${PK_HYDRATION:?Missing PK_HYDRATION (Hydration EVM private key)}
export PK_HYDRATION

# The contract must be the pinned, unmodified URD.
node "$ROOT_DIR/tools/check-pin.ts"

cd "$ROOT_DIR/contracts"
forge script script/DeployRewardsDistributor.s.sol --rpc-url "$RPC_HYDRATION" --broadcast --legacy $FORGE_EVM
unset PK_HYDRATION

node "$ROOT_DIR/tools/distributor-deployment.ts" record "$ENV"
bash "$ROOT_DIR/sh/verify-distributor.sh" "$ENV"

echo
if [ -n "${URD_UPDATER:-}" ]; then
  echo "The deployer added $URD_UPDATER as root updater and handed the distributor to $URD_OWNER."
  echo "Next: list what the deployer did while it owned it (README.md, \"Deploying the distributor\")."
  echo "No PRIME goes to the distributor before that."
else
  echo "Next: the owner calls setRootUpdater(<root-posting address>, true), then"
  echo "  bash sh/verify-distributor.sh $ENV <root-posting address>"
  echo "No PRIME goes to the distributor before that check passes."
fi
