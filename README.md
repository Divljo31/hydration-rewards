# hydration-rewards

Reward programs for Hydration that pay on rules instead of gross balances. An offchain job
snapshots the chain every hour, applies the program, closes a daily epoch, and turns the
result into a cumulative Merkle root for Morpho's Universal Rewards Distributor (URD), which users
claim from. The URD is Morpho's contract, unmodified, pinned at
`3de504b130835a12482e00e1c83dcf369448c80b`; `tools/check-pin.ts` fails if anyone edits it.

The program pays PRIME on HUSDC, HUSDT and HEURC only to accounts that have not borrowed HOLLAR:
`programs/htoken-no-hollar-borrowers.yaml`. An account with HOLLAR debt above the program's
allowance earns nothing for the hours it has that debt. Only HOLLAR debt counts; debt in other
assets is not recorded. A different strategy is a code change, not a setting.

## Layout

| Path | What it is |
| --- | --- |
| `programs/` | The program file: the first epoch it pays, budget, earning assets, start hour, HOLLAR allowance. `programs/README.md` explains every setting. |
| `config/` | Chain addresses (`mainnet.json`) and accounts that never earn (`denylist.json`, which excludes nobody today). |
| `src/snapshot.ts` | Hourly, once the hour is over: balances, HOLLAR debt per market and oracle prices at one of the hour's blocks, picked by the hash of the block after it. |
| `src/close-epoch.ts` | Daily: the epoch's snapshots and the program become a payout CSV, a summary and the cumulative tree. |
| `src/preview.ts` | What a program would pay, using snapshots already taken. Writes nothing. |
| `src/bot.ts` | The runner: takes each hourly snapshot and closes each finished epoch. |
| `src/publish.ts` | The files the app reads: claims and proofs per root, and who is earning. |
| `src/eligibility.ts`, `src/allocate.ts`, `src/build-tree.ts`, `src/program.ts` | Who is eligible, the budget split, the cumulative tree in URD leaf format, and the program file reader. |
| `src/lib/`, `src/types.ts` | RPC client, holder index, the snapshot block rule, addresses, file and number helpers; the shapes of the config, snapshots, programs and trees. |
| `contracts/` | The URD (git submodule), the deploy script and Foundry tests against the real URD. |
| `tools/` | Fixture generator and pin check, used by the tests and CI; the recorder and checker of a distributor deployment. |
| `sh/`, `migrations/envs/`, `deployments/` | Deploying the distributor: the wrappers, the settings for each environment, and the record of what was deployed. |
| `Dockerfile`, `docker/` | The runner's image and its Docker Swarm stack (see Running in Docker). |
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

Every change also moves `applies_from_epoch`, the first epoch the file pays, to an epoch that has
not been closed yet. The closer holds the file to it: it refuses an earlier epoch, and after that
epoch it refuses to build on an epoch closed with any other file. So a change takes effect exactly
where its review said, whenever the runner picks it up. Put the merged file on the runner's host,
then restart the runner with it once it has closed the epoch before `applies_from_epoch`. Until the
restart, the runner reports the waiting file in its log and in `data/status.json` (`programOnDisk`,
with the epoch it applies from), keeps closing the epochs before that one with the old file, and
closes nothing from `applies_from_epoch` on; `public/latest.json` keeps showing the old file's
rules. Its first pass after a restart checks the file against the stored epochs, and says what is
wrong:
- Too early: the open epoch is before `applies_from_epoch`, so it closes nothing (it still takes the
  hours). Close the earlier epochs by hand with the old file, or run the old file until they are
  closed. For the very first epoch, start with `--first-epoch` at `applies_from_epoch`, or move the
  date.
- Too late, when the new file reached the host after the old one had closed `applies_from_epoch`: if
  no root from `applies_from_epoch` on was posted, move the outputs (`data/trees` and `data/epochs`)
  of `applies_from_epoch` and of every later epoch aside, and the runner closes them again in order
  with the new file. Otherwise move `applies_from_epoch` to the epoch the refusal names, the first
  one not closed yet, in a new pull request.
- An older file than the one that closed the newest epoch: restart with the newer one.

## Running

The start hour, the budgets and the program's first epoch are decisions, so they have no
defaults; closing refuses to run while they are blank in the program file.

```sh
# Every hour, once it has ended: the hour's block is picked by the hash of the first block after it,
# so that block must be finalized. --at is unix seconds or a time with its zone.
node src/snapshot.ts --at 2027-01-15T15:00:00Z

# Once a day, after the epoch's 24th snapshot (--genesis instead of --prev for the very first epoch):
node src/close-epoch.ts --epoch 2027-01-15 --program programs/htoken-no-hollar-borrowers.yaml \
  --prev data/trees/2027-01-14.json

# Any time, to see what a program would pay:
node src/preview.ts --program programs/htoken-no-hollar-borrowers.yaml
```

Snapshots are stored as `data/snapshots/<unix hour>.json`; the closer reads exactly the 24 files
of its epoch. They are format `hydration-rewards-snapshot/2`: snapshots taken by an earlier version
(format /1, at the first block of each hour) are not read, so move them aside, and the runner takes
those hours again within its 72-hour backlog (older ones by hand with `--at`). Outputs go under
`data/`, which is not checked in. The first snapshot scans aToken
Transfer logs from the aTokens' deploy block, which takes a long time on the public RPC. The index
is built for the earning assets in `config/mainnet.json`: after one is added there, move
`data/state/holders.json` aside and let it be built again. The scan
resumes where it stopped (`node src/snapshot.ts --index-only` runs it on its own, and
`--index-only --rescan <blocks>` scans its tail again if a snapshot reports missing holders). One
process updates the index at a time (`data/state/holders.json.lock`): a scan by hand stops while
the runner is updating it, and the runner's snapshots fail and are retried while a scan by hand
runs. Set `RPC_HYDRATION` (in the
shell or in a `.env` file, see `.env.example`) or `--rpc` to use another archive node, and behind
an HTTP proxy run with `NODE_USE_ENV_PROXY=1`. The node must serve the chain id in
`config/mainnet.json`, and errors name it by its host only, so a key in its URL stays out of logs.

Posting a root is manual: the updater key calls `submitRoot(tree.root, sha256 of the tree file)`,
and anyone calls `acceptRoot()` 12 hours later. Before posting, check that the tree's
`previousRoot` is the root the URD holds. A claim uses the tree of the root the URD holds, not the
latest tree, which may still be pending: `claim(account, PRIME, claimable, proof)` with
`claims[account]` from `data/public/trees/<root()>.json` (see Files for the app).

## Running as a bot

`src/bot.ts` does the two commands above on its own. Every minute it looks at the files under
the data directory, takes the snapshot of every hour that has ended, and closes every epoch whose 24
snapshots are there, each on the tree of the day before. An hour is taken a minute or two after it
ends, once the block after it is finalized, so an epoch closes shortly after its last hour. It keeps
no other state, so after a restart or downtime it catches up from the newest tree (it refuses a
backlog of more than 72 hours). A failure in one step does not stop the steps that do not depend on
it: a snapshot that fails stops that pass's snapshots, but epochs whose snapshots are all there are
still closed. Every failure is reported and tried again on the next pass, and nothing is skipped.

```sh
node src/bot.ts --first-epoch 2027-01-15          # or FIRST_EPOCH; add --once for a single pass
```

It reads the program file once, when it starts (see Changing the program for when to restart it
with a new one). It reads the denylist on every pass, so a change to it applies from the next close
without a restart; a denylist that does not load stops the closes until it is fixed, not the
snapshots. It refuses to start while the program's budgets, start hour or `applies_from_epoch` are
blank, when the denylist does not load, when another runner holds the data directory
(`data/bot.lock`), and when trees older than the first epoch already exist (a wrong date would start
a new tree without them). The runner refreshes its lock every minute and releases it when it stops
on SIGTERM, SIGINT or SIGHUP. A lock is taken over when its process is gone, when it has not been
refreshed for 10 minutes, or when it names the starting process's own pid and has not been refreshed
for 2½ minutes: a container restart gives the same pid, so a crashed runner's container starts again
within a few minutes, which its restart policy covers.

An hour in which the chain produced no block is skipped and reported. Once the epoch's other hours
are all taken, from an hour after the epoch ends, a person closes it with `--allow-partial`, which
refuses before then. After a day that a person closed around with `--allow-gap`, it carries on from
the newest tree. It does not post
roots: after each close its log shows the `submitRoot(root, sha256)` call, with a warning while the
denylist is provisional. `data/status.json` holds the open epoch, the latest tree's root, the
epochs the last pass closed (also when it failed afterwards), the program and denylist hashes and
the last error.

Not built yet: hosting the published files, posting roots, checking the URD's root and PRIME
balance, and alerting when a pass keeps failing.

## Running in Docker

The image holds the runner with the program file and `config/` of the commit it was built from, and
keeps all its state in `/data`:

```sh
docker build -t hydration-rewards --build-arg VCS_REF="$(git rev-parse HEAD)" .
docker run --rm -e FIRST_EPOCH=2027-01-15 -v hydration-rewards-data:/data hydration-rewards
```

`docker/stack.yml` is the stack for Docker Swarm (Swarmpit): one replica and the data volume. The
runner locks its data directory, so the old task is stopped before the new one starts, and the stack
gives the service a fixed hostname so that a task replacing a crashed one takes the lock over within
about 2½ minutes. The container is healthy while the runner refreshes that lock, which it does every
minute, also during a long catch-up. A pass that keeps failing shows in `data/status.json`, not in
the health check.

The program file is part of the image, so a program change is a new image. Deploy it once the
running one has closed the epoch before the new file's `applies_from_epoch`, and before that epoch
closes (see Changing the program). That is why the stack does not redeploy by itself when a new
image is pushed.

`.github/workflows/image.yml` builds the image for linux/amd64 on every push to `master` that touches
it and publishes the same build to `docker.io/galacticcouncil/hydration-rewards` and
`ghcr.io/galacticcouncil/hydration-rewards`, tagged `latest` and with the full commit SHA. The workflow
checks that both registries return the same digest. It deploys nothing.

Docker Hub publishing uses the repository Actions secrets `DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN`;
the token must have push access to `galacticcouncil/hydration-rewards`. GHCR uses the workflow's
`GITHUB_TOKEN` with `packages: write`. The image's source label links the GHCR package to this
repository. New GHCR packages start private; choose visibility in the package settings before
expecting anonymous pulls. The Swarm stack uses the Docker Hub image.

## Files for the app

Everything the app needs to show and claim these rewards is written under `data/public`. Serve
that folder, and only that folder, over HTTPS with CORS enabled: `data/status.json` next to it is
the runner's own state and can contain RPC error text.

| File | Written | Holds |
| --- | --- | --- |
| `public/trees/<root>.json` | When an epoch is closed, by the runner or by hand, before its tree; the runner writes any stored tree's file again if it goes missing | The reward token, the root, and every account's cumulative `claimable` and `proof` |
| `public/latest.json` | By the runner, whenever a snapshot or a close changes it, or it restarts with another program file; not while it reports a program or denylist problem | Who is earning as of the newest snapshot, the daily budget and eligible value per asset, and the newest closed epoch's root |

To claim for an account:

1. Read `root()` from the distributor. That is the root users can claim against; a newer root
   may be pending for 12 hours.
2. Fetch `public/trees/<root>.json`. A 404 means nothing can be claimed yet.
3. Take `claims[account]`. No entry means the account has earned nothing.
4. What is still owed is `claimable - claimed(account, reward)`, read from the distributor.
5. Call `claim(account, reward, claimable, proof)` with the cumulative `claimable` from the file,
   not the difference. Anyone can send it; the tokens go to `account`.

The keys of `claims` and of `accounts` are lowercase 0x addresses: lowercase the address a wallet
gives (it is often mixed case) before looking it up. The `account` sent to `claim` may be either.
`claimable` and `budgetPerDay` are raw units of the reward token (`reward.decimals` in
`latest.json`, 6 for PRIME); dollar amounts have two decimals.

In `latest.json`, `accounts[account]` is `{ earning: true }`, or `{ earning: false, reason }` with
`reason` `hollar_debt` (more HOLLAR debt than `program.maxHollarDebtUsd`) or `excluded` (on the
denylist). An account that is not listed supplied no earning asset at that snapshot. The yearly
rate for an asset is
`(assets[asset].budgetPerDay ÷ 10^reward.decimals) × 365 × reward price ÷ assets[asset].eligibleUsd`.

Two things the app cannot show from these files: rewards do not accrue second by second (amounts
change once a day, when an epoch closes), and `earning` is as of the last hourly snapshot, not live
(an hour is taken after it ends, so the newest one is up to two hours old). While the runner
reports a problem `latest.json` stops moving, so the app compares `asOf.hour` with the clock and
shows older data as stale.
Tree files are named after the root and never removed; `latestTree.root` differs from the
distributor's root while a root is waiting out the timelock or has not been posted.

## Deploying the distributor

The deployment is scripted, the way the migrations in `whm` are: settings for each environment in
`migrations/envs/<env>/distributor.env`, the deployer's key from `PK_HYDRATION` (in the shell or in
`.env`, never on a command line), and a record of what was deployed in
`deployments/<env>/distributor.json`. Rehearse on a local fork first:

```sh
npm run fork:hydration             # a local fork of Hydration's EVM (anvil); leave it running
npm run migrate:distributor:fork   # deploy, record and check against the fork
```

Then, with the rewards multisig in `URD_OWNER` in `migrations/envs/prod/distributor.env`:

```sh
PK_HYDRATION=<deployer key> npm run migrate:distributor
```

The deployer needs an `EVMAccounts.ContractDeployer` slot on Hydration. The migration checks that
the URD is the pinned, unmodified commit, deploys it in one transaction with the multisig as owner
(the deployer never holds a role), writes the record, and runs the checks below. It refuses to run
again while a production record exists. The multisig then adds the root-posting key with
`setRootUpdater(<root-posting address>, true)`, and the checks are run once more with that address:

```sh
npm run verify:distributor -- <root-posting address>
```

`verify` needs no key and sends nothing. Do not fund the URD until it passes. If it fails, leave
that URD empty and deploy a new one; do not try to repair it. It checks:

1. The state (`check(address)` in the deploy script): the code is the pinned URD's byte for byte (a
   look-alike with a backdoor would answer every getter the same), the multisig is the owner (the
   handover completed), the timelock is the one in the settings, no root is set or pending (a
   deployer that set the timelock to zero first can make its root acceptable at once), the deployer
   holds no role, and the root-posting address, when given, is an updater.
2. The creation transaction (`tools/distributor-deployment.ts`): it creates the contract directly,
   it was sent by the deployer, and its input is exactly the pinned URD's creation code followed by
   the expected constructor arguments. Code with the right bytes can still come from init code that
   wrote other storage first, and this rules that out.

Hydration's blocks carry no `prevrandao`, and forge refuses to run a script against such a chain
with the EVM version the URD is pinned to (`paris`). The scripts therefore pass
`--evm-version london`, after checking on every run that the URD compiles to the same bytes either
way. A `forge script` run by hand against Hydration needs the same flag.

With a hardware wallet or a keystore instead of `PK_HYDRATION`, run the deploy script directly and
then record and check it:

```sh
cd contracts && set -a && source ../migrations/envs/prod/distributor.env && set +a
forge script script/DeployRewardsDistributor.s.sol --rpc-url "$RPC_HYDRATION" --broadcast --legacy \
  --evm-version london --sender <deployer> --ledger      # or --account <keystore>
node ../tools/distributor-deployment.ts record prod && npm run verify:distributor
```

With the root-posting address in `URD_UPDATER` in the settings, the multisig has nothing to send:
the script deploys in three transactions instead (create, add the updater, hand ownership to the
multisig), and the checks include that address without it being passed. The deployer owns the URD
in between: it could submit a root of its own, or make itself an updater, before the handover.
Prefer the single transaction. After a three-transaction deployment, also list what the deployer
did while it owned the URD. The script sends its three transactions back to back, so the handover
lands within minutes of the creation block; list the first 1,000 blocks (about 40 minutes, well
within what the public node answers):

```sh
cast logs --rpc-url "$RPC_HYDRATION" --address <URD> --from-block <creation block> \
  --to-block <creation block + 1000> 'OwnerSet(address indexed newOwner)'
cast logs --rpc-url "$RPC_HYDRATION" --address <URD> --from-block <creation block> \
  --to-block <creation block + 1000> 'RootUpdaterSet(address indexed rootUpdater, bool active)'
```

The OwnerSet events must be the deployer at creation and then the multisig, and the only
RootUpdaterSet before that handover must add the root-posting key. A handover outside the range
fails the check too: the deployer owned the URD for longer than the script takes.

The script refuses a timelock of a day or more, because a new `submitRoot` replaces the pending
root and restarts its clock.

## What stops a run

- Any RPC error or missing batch item: a failed read is never recorded as zero.
- A node that serves another chain id than the config's.
- A snapshot hour that is not over, or whose next block is not finalized yet; a time that is not
  on the hour, or that is given without its zone.
- Holder balances that do not add up to an aToken's total supply.
- An aToken that differs from the config, HOLLAR missing from any of the three markets, or an
  oracle that does not price in 8 decimals.
- A missing snapshot for any hour of the epoch, one taken at a block outside its hour, or one at
  another block than the one its hour's seed block picks (`--allow-partial` accepts missing hours
  and still pays the full budget, from an hour after the epoch ends).
- A program file with an unknown setting or asset, an asset listed twice, a blank budget, start
  hour or `applies_from_epoch`, or no HOLLAR allowance.
- An epoch before the program file's `applies_from_epoch`, or a close after it on top of an epoch
  that was closed with another file.
- A previous tree that is not the day before's, or whose epoch did not end where this one starts
  (a changed start hour); `--allow-gap` overrides, for a day that could never be closed and has no
  tree. A close must build on the newest stored tree before it: `--allow-gap` past a closed day,
  and `--genesis` once any epoch is closed, are refused.
- A previous tree that is not the one stored for its epoch, or that builds on a tree that is no
  longer stored (its epoch was closed again after this one was built on it, or its file is gone).
- A previous tree whose root does not rebuild from its claims, or that pays another token.
- An epoch that is not a real calendar date, or an hour in which the chain produced no block.
- An epoch that was already closed with a different result (`--overwrite` replaces it while no
  later epoch is closed; only do that if its root was never posted), or one that a later epoch was
  closed without. Also an epoch with no tree whose CSV or summary differ from this close: an earlier
  close stopped before its tree (then `--overwrite` is safe) or the tree was removed by hand.
- In the runner, an epoch from the `applies_from_epoch` of a program file on disk that takes over
  later than the running one (a file on disk that would not take over is only reported).
- Another process holding the data directory (`bot.lock`) or the holder index
  (`state/holders.json.lock`).
- A first epoch without `--genesis`, an account that is not a 20-byte address, or rounding dust
  not below the number of earning accounts.

## Open decisions

- PRIME budget per day for each asset. Referendum 423 pays 275.616 PRIME/day each to HUSDC and
  HUSDT on gross balances until 1800021600 (15 Jan 2027 14:00 UTC). HEURC's stream has already
  ended, so its budget is new PRIME.
- Epoch start hour and the cutover date (the first epoch, and the program's `applies_from_epoch`).
  The live stream is stopped at the first epoch's start, and what is left in its pot moves to the
  URD, by one referendum.
  It ends by itself at 1800021600, so a first epoch that starts then needs no stop, only the move.
- How the program is paid once what is left in the old pot is spent, and the margin left in that pot.

- What happens to an asset's budget when nobody is eligible (left undistributed and reported today).
- Multisig signers, who holds the root-posting key, and how users claim.

## Known limits

- HOLLAR borrowed on one wallet and H-tokens held on another is not caught.
- Each hour's block is picked after the hour, by the hash of the first block after it, so a
  deposit, a withdrawal or a HOLLAR repayment cannot be timed around it: a position held for part
  of an hour earns that part on average. The collator that authors that one block could bias the
  pick among the hour's blocks.
- Sending less than 0.009901 PRIME (its existential deposit) to an account that holds no PRIME
  reverts on the asset precompile, so such a claim waits until the account's unclaimed amount is
  larger.
- A payout to a Substrate account's EVM address reaches that account only if it has bound the
  address; accounts are 20-byte addresses throughout for that reason. Supplying to the money market
  needs the binding, so this only concerns aTokens transferred to an unbound account's address.
- The closer does not read the URD, so it cannot check that the previous tree is the one on chain.
- A first epoch in which nobody earns cannot be closed, because a tree needs at least one account.
- Each snapshot makes its RPC calls one after another; a long catch-up is slow on the public node.

## Licence

Apache-2.0 (`LICENSE.md`) for this repository's own code. `contracts/lib/universal-rewards-distributor`
is Morpho's, under GPL-2.0-or-later or the Business Source License at the licensee's choice; the
deploy script and Foundry test import it and carry GPL-2.0-or-later headers.
