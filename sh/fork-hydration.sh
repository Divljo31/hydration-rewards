#!/usr/bin/env bash
set -euo pipefail

# A local fork of Hydration's EVM, for rehearsing a deployment before it goes to mainnet:
#   npm run fork:hydration            (leave it running)
#   npm run migrate:distributor:fork
#
# It is a plain EVM (anvil): Hydration's precompiles and its deployer whitelist are not there, so a
# fork run rehearses the deployment and its checks, not token transfers.

RPC=https://rpc.hydradx.cloud
CHAIN_ID=222222
PORT=8547

echo "Forking hydration..."
echo "RPC: $RPC"
echo "Chain ID: $CHAIN_ID"
echo

anvil \
  --fork-url $RPC \
  --chain-id $CHAIN_ID \
  --port $PORT
