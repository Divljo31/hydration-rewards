# hydration-rewards

Reward programs for Hydration that pay on rules instead of gross balances. An offchain job
snapshots the chain every hour, applies the program, closes a daily epoch, and turns the
result into a cumulative Merkle root for Morpho's Universal Rewards Distributor (URD), which users
claim from. The URD is Morpho's contract, unmodified, pinned at
`3de504b130835a12482e00e1c83dcf369448c80b`; `tools/check-pin.ts` fails if anyone edits it.

The program pays PRIME on HUSDC and HUSDT only to accounts that have not borrowed HOLLAR:
`programs/htoken-no-hollar-borrowers.yaml`. An account with HOLLAR debt above the program's
allowance earns nothing for the hours it has that debt. Only HOLLAR debt counts; debt in other
assets is not recorded. A different strategy is a code change, not a setting.

## Layout

| Path | What it is |
| --- | --- |
| `programs/` | The program file: budget, earning assets, start hour, HOLLAR allowance. `programs/README.md` explains every setting. |
| `config/` | Chain addresses (`mainnet.json`) and accounts that never earn (`denylist.json`). |
| `src/snapshot.ts` | Hourly: balances, HOLLAR debt per market and oracle prices at one finalized block. |
| `src/close-epoch.ts` | Daily: the epoch's snapshots and the program become a payout CSV, a summary and the cumulative tree. |
| `src/preview.ts` | What a program would pay, using snapshots already taken. Writes nothing. |
| `src/bot.ts` | The runner: takes each hourly snapshot and closes each finished epoch. |
| `src/eligibility.ts`, `src/allocate.ts`, `src/build-tree.ts`, `src/program.ts` | Who is eligible, the budget split, the cumulative tree in URD leaf format, and the program file reader. |
| `src/lib/`, `src/types.ts` | RPC client, holder index, addresses, file and number helpers; the shapes of the config, snapshots, programs and trees. |
| `contracts/` | The URD (git submodule), the deploy script and Foundry tests against the real URD. |
| `tools/` | Fixture generator and pin check, used by the tests and CI. |
| `.claude/skills/reward-program/` | Claude skill: describe a change in plain words, get a previewed pull request. |

## Setup and tests

```sh
./setup.sh      # URD submodule and its libraries, npm ci, pin check
npm test        # node --test, then forge test against the real URD
npm run lint    # Prettier and a strict TypeScript check of src/, tools/ and test/
```

Node 26 (`.nvmrc`), which runs the TypeScript sources directly with no build step, and Foundry
with solc 0.8.19.

## Changing the program

Edit the file in `programs/`, run the preview, and open a pull request; or open Claude Code in
this repository and describe the change, and the `reward-program` skill does those steps. Close
epochs only with a program file that has been merged after review; nothing in the code enforces
that, but every epoch summary records the hash of the file it used.

## Running

The start hour and the budgets are decisions, so they have no defaults; closing refuses to run
while they are blank in the program file.

```sh
# Every hour, on the hour (the block is the first finalized one at or after --at):
node src/snapshot.ts --at 2027-01-15T15:00:00Z

# Once a day, after the epoch's 24th snapshot (--genesis instead of --prev for the very first epoch):
node src/close-epoch.ts --epoch 2027-01-15 --program programs/htoken-no-hollar-borrowers.yaml \
  --prev data/trees/2027-01-14.json

# Any time, to see what a program would pay:
node src/preview.ts --program programs/htoken-no-hollar-borrowers.yaml
```

Snapshots are stored as `data/snapshots/<unix hour>.json`; the closer reads exactly the 24 files
of its epoch. Outputs go under `data/`, which is not checked in. The first snapshot scans aToken
Transfer logs from the aTokens' deploy block, which takes a long time on the public RPC; the scan
resumes where it stopped (`node src/snapshot.ts --index-only` runs it on its own, and
`--index-only --rescan <blocks>` scans its tail again if a snapshot reports missing holders). Set
`RPC_HYDRATION` (in the shell or in a `.env` file, see `.env.example`) or `--rpc` to use another
archive node, and behind an HTTP proxy run with
`NODE_USE_ENV_PROXY=1`.

Posting a root is manual: the updater key calls `submitRoot(tree.root, sha256 of the tree file)`,
and anyone calls `acceptRoot()` 12 hours later.
A claim is `claim(account, PRIME, claims[account].claimable, claims[account].proof)` from the
latest tree. Before posting, check that the tree's `previousRoot` is the root the URD holds.

## Running as a bot

`src/bot.ts` does the two commands above on its own. Every minute it looks at the files under
the data directory, takes the snapshot of every hour that is due, and closes every epoch whose 24
snapshots are there, each on the tree of the day before. It keeps no other state, so after a
restart or downtime it catches up from where the files stop (it refuses a backlog of more than 72
hours). A failure stops that pass and is tried again on the next; nothing is skipped.

```sh
node src/bot.ts --first-epoch 2027-01-15          # or FIRST_EPOCH; add --once for a single pass
```

It refuses to start while the program's budgets or start hour are blank, and when trees older
than the first epoch already exist (a wrong date would start a new tree without them). An hour in
which the chain produced no block is skipped and reported; its epoch then waits for a person to
close it with `--allow-partial`. It does not post roots: after each close its log shows the
`submitRoot(root, sha256)` call, with a warning while the denylist is provisional, and
`data/status.json` holds the open epoch, the latest tree's root and the last error.

Not built yet: packaging for deployment, posting roots, checking the URD's root and PRIME
balance, publishing the tree so users can fetch their proofs, and alerting when a pass keeps failing.

## Deploying the distributor

```sh
cd contracts
URD_OWNER=<rewards multisig> URD_UPDATER=<root-posting key> \
forge script script/DeployRewardsDistributor.s.sol --rpc-url hydration --broadcast --legacy \
  --sender <deployer> --private-key <key>      # or --account / --ledger
```

Then check the result on chain, with the same environment and the address the script printed:

```sh
URD_OWNER=<rewards multisig> URD_UPDATER=<root-posting key> \
forge script script/DeployRewardsDistributor.s.sol --rpc-url hydration --sig "check(address)" <URD>
```

The handover is three transactions (create, add the updater, hand ownership to the multisig). If
the last one does not land, the deployer still owns the URD and can set roots without the timelock;
the check fails in that case.

The deployer must be on Hydration's EVM deployer whitelist (`evmAccounts.addContractDeployer`,
granted by governance). The script refuses a timelock of a day or more, because a new `submitRoot`
replaces the pending root and restarts its clock, and it ends with the multisig as owner and the
deployer holding no role.

## What stops a run

- Any RPC error or missing batch item: a failed read is never recorded as zero.
- A snapshot hour whose first block is not finalized yet, or a time that is not on the hour.
- Holder balances that do not add up to an aToken's total supply.
- An aToken that differs from the config, HOLLAR missing from any of the three markets, or an
  oracle that does not price in 8 decimals.
- A missing snapshot for any hour of the epoch, or one taken at a block outside its hour
  (`--allow-partial` accepts missing hours and still pays the full budget).
- A program file with an unknown setting or asset, an asset listed twice, a blank budget or start
  hour, or no HOLLAR allowance.
- A previous tree that is not the day before's, or whose epoch did not end where this one starts
  (a changed start hour); `--allow-gap` overrides, for a day that could never be closed.
- A previous tree whose root does not rebuild from its claims, or that pays another token.
- An epoch that is not a real calendar date, or an hour in which the chain produced no block.
- An epoch that was already closed with a different result (`--overwrite` replaces it; only do that
  if its root was never posted).
- A first epoch without `--genesis`, an account that is not a 20-byte address, or rounding dust
  not below the number of paid accounts.

## Open decisions

- PRIME budget per day for each asset. Referendum 423 pays 275.616 PRIME/day each to HUSDC and
  HUSDT on gross balances until 1800021600 (15 Jan 2027 14:00 UTC).
- Epoch start hour and the cutover date, and whether the live stream is stopped at that point.
- Denylist addresses still listed under `unresolved` in `config/denylist.json`.
- What happens to an asset's budget when nobody is eligible (left undistributed and reported today).
- Multisig signers, who holds the root-posting key, and how users claim.

## Known limits

- HOLLAR borrowed on one wallet and H-tokens held on another is not caught.
- Snapshot blocks are predictable (the first block of each hour), so HOLLAR can be repaid just
  before one and borrowed again after it.
- Sending less than 0.009901 PRIME (its existential deposit) to an account that holds no PRIME
  reverts on the asset precompile, so such a claim waits until the account's unclaimed amount is
  larger.
- A payout to a Substrate account's EVM address reaches that account only if it has bound the
  address; accounts are 20-byte addresses throughout for that reason.
- The closer does not read the URD, so it cannot check that the previous tree is the one on chain.
- A first epoch in which nobody earns cannot be closed, because a tree needs at least one account.
- Each snapshot makes its RPC calls one after another; a long catch-up is slow on the public node.

## Licence

Apache-2.0 (`LICENSE.md`) for this repository's own code. `contracts/lib/universal-rewards-distributor`
is Morpho's, under GPL-2.0-or-later or the Business Source License at the licensee's choice; the
deploy script and Foundry test import it and carry GPL-2.0-or-later headers.
