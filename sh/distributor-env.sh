# Sourced by migrate-distributor.sh and verify-distributor.sh, with ENV and ROOT_DIR set.
# Loads the settings and decides how forge is run against Hydration.

ENV_FILE="$ROOT_DIR/migrations/envs/$ENV/distributor.env"
STATE="$ROOT_DIR/deployments/$ENV/distributor.json"

if [ ! -f "$ENV_FILE" ]; then
  echo "No settings for '$ENV': $ENV_FILE is missing" >&2
  exit 1
fi

if [ -f "$ROOT_DIR/.env" ]; then
  set -a
  source "$ROOT_DIR/.env"
  set +a
fi
set -a
source "$ENV_FILE"
set +a

if [ "$ENV" = "fork" ]; then
  case "$RPC_HYDRATION" in
    http://127.0.0.1:*|http://localhost:*) ;;
    *) echo "The fork run only talks to a local node, not to $RPC_HYDRATION" >&2; exit 1 ;;
  esac
fi

# Hydration's blocks carry no prevrandao, and forge refuses to run a script against such a chain
# with the EVM version the URD is pinned to ("paris"). The scripts therefore run with "london",
# which is only allowed because the URD compiles to the same bytes either way; that is checked
# here on every run, before anything is sent.
FORGE_EVM="--evm-version london"
URD_CONTRACT="lib/universal-rewards-distributor/src/UniversalRewardsDistributor.sol:UniversalRewardsDistributor"
(
  cd "$ROOT_DIR/contracts"
  for kind in bytecode deployedBytecode; do
    if [ "$(forge inspect "$URD_CONTRACT" "$kind")" != "$(forge inspect "$URD_CONTRACT" "$kind" $FORGE_EVM)" ]; then
      echo "The URD's $kind differs between the pinned EVM version and london; nothing was sent" >&2
      exit 1
    fi
  done
)
