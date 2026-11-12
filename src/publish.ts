// What the app reads to show and claim these rewards. Everything is under <data>/public, the only
// folder meant to be served: the runner's own status.json next to it can carry RPC error text and
// is not for publication.
//
//   public/trees/<root>.json   claims and proofs for one root (ClaimsFile)
//   public/latest.json         who is earning as of the newest snapshot (LatestFile)
//
// To claim, the app reads the root the distributor holds, fetches trees/<root>.json (a 404 means
// nothing can be claimed yet) and calls claim(account, reward, claims[account].claimable, proof).
// `claimable` is cumulative: what is still owed is claimable - claimed(account, reward).

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { snapshotEligibility } from "./eligibility.ts";
import { compareAddresses } from "./lib/accounts.ts";
import { usdExact } from "./lib/format.ts";
import { toJson, writeText } from "./lib/io.ts";
import type {
  AccountStatus,
  ClaimsFile,
  Denylist,
  LatestFile,
  Program,
  RewardConfig,
  Snapshot,
  Tree,
} from "./types.ts";

const CLAIMS_FORMAT = "hydration-rewards-claims/1";
const LATEST_FORMAT = "hydration-rewards-latest/1";

export const claimsPath = (dataDir: string, root: string): string => join(dataDir, "public", "trees", `${root}.json`);

export const latestPath = (dataDir: string): string => join(dataDir, "public", "latest.json");

// Only what the root commits to. A day that pays nobody ends on the same root as the day before,
// so this file must come out the same whichever epoch wrote it.
export function claimsFile(tree: Tree): ClaimsFile {
  return {
    format: CLAIMS_FORMAT,
    reward: tree.reward,
    root: tree.root,
    leafEncoding: tree.leafEncoding,
    claims: tree.claims,
  };
}

// Who is earning at one snapshot, decided by the same eligibility code that pays the rewards.
export function latestFile({
  snapshot,
  program,
  reward,
  denylist,
  latestTree,
}: {
  snapshot: Snapshot;
  program: Program;
  reward: RewardConfig;
  denylist: Pick<Denylist, "reasonFor">;
  latestTree: { epoch: string; root: string } | null;
}): LatestFile {
  const { eligible, excluded, borrowers, debts } = snapshotEligibility(snapshot, {
    maxHollarDebt: program.maxHollarDebt,
    earn: program.earn,
    denylist,
  });

  const eligibleValue = new Map(program.earn.map((name): [string, bigint] => [name, 0n]));
  const accounts: [string, AccountStatus][] = [];
  for (const [account, perAsset] of eligible) {
    for (const [name, value] of perAsset) eligibleValue.set(name, (eligibleValue.get(name) ?? 0n) + value);
    const debt = debts.get(account);
    if (debt === undefined) throw new Error(`no HOLLAR debt was worked out for ${account}`);
    accounts.push([
      account,
      borrowers.accounts.has(account)
        ? { earning: false, reason: "hollar_debt", hollarDebtUsd: usdExact(debt) }
        : { earning: true, hollarDebtUsd: usdExact(debt) },
    ]);
  }
  for (const account of excluded.keys()) accounts.push([account, { earning: false, reason: "excluded" }]);
  accounts.sort(([a], [b]) => compareAddresses(a, b));

  return {
    format: LATEST_FORMAT,
    asOf: { hour: snapshot.target, block: snapshot.block.number, blockTime: snapshot.block.timestamp },
    reward: { symbol: reward.symbol, address: reward.address, decimals: reward.decimals },
    program: { name: program.name, sha256: program.sha256, maxHollarDebtUsd: usdExact(program.maxHollarDebt) },
    assets: Object.fromEntries(
      program.earn.map((name) => {
        const budget = program.budgetPerDay.get(name);
        return [
          name,
          {
            budgetPerDay: budget === null || budget === undefined ? null : budget.toString(),
            eligibleUsd: usdExact(eligibleValue.get(name) ?? 0n),
          },
        ];
      }),
    ),
    accounts: Object.fromEntries(accounts),
    latestTree,
  };
}

// Writes latest.json unless it already holds exactly this, so an idle runner leaves it untouched.
export function publishLatest(dataDir: string, latest: LatestFile): boolean {
  const path = latestPath(dataDir);
  const text = toJson(latest);
  if (existsSync(path) && readFileSync(path, "utf8") === text) return false;
  writeText(path, text);
  return true;
}
