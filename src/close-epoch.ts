#!/usr/bin/env node
// Closes one daily epoch: stored snapshots -> eligible sums -> PRIME per account -> epochs/<epoch>.csv
// -> cumulative tree (src/build-tree.ts) on top of the previous epoch's tree.
//
// Every setting comes from the program file (programs/README.md): budgets, start hour, earning
// assets and the HOLLAR allowance.
//
// Usage:
//   node src/close-epoch.ts --epoch 2026-11-12 --program programs/htoken-no-hollar-borrowers.yaml \
//     (--prev data/trees/2026-11-11.json | --genesis)
//   --allow-partial   close with fewer than the expected snapshots (the full budget is still paid)
//   --allow-gap       build on a tree older than the day before (a day that could never be closed)
//   --overwrite       replace outputs of an earlier close that differ from this one

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { buildTree } from "./build-tree.ts";
import { compareAddresses } from "./lib/accounts.ts";
import { epochDayStart } from "./lib/epoch.ts";
import { usdExact } from "./lib/format.ts";
import { messageOf, readJson, sha256, toJson, writeText } from "./lib/io.ts";
import { allocate } from "./allocate.ts";
import { epochEligibility, SNAPSHOT_FORMAT } from "./eligibility.ts";
import { loadDenylist } from "./lib/denylist.ts";
import { loadProgram } from "./program.ts";
import type { Config, EpochWindow, Program, Snapshot, Tree } from "./types.ts";

const EPOCH_SUMMARY_FORMAT = "hydration-rewards-epoch/1";
const DAY = 86_400;

// The epoch CSV: `account,amount`, amounts in raw reward-token units (PRIME has 6 decimals).
// Rows are sorted by account and zero amounts are left out, so the same allocation always
// produces the same bytes. It is a record for people; the tree is built from the amounts directly.
export function formatEpochCsv(amounts: Map<string, bigint>): string {
  const rows = [...amounts.entries()].filter(([, amount]) => amount > 0n).sort(([a], [b]) => compareAddresses(a, b));
  let out = "account,amount\n";
  for (const [account, amount] of rows) out += `${account},${amount}\n`;
  return out;
}

export function epochWindow(epoch: string, startHourUtc: number | null | undefined): EpochWindow {
  const day = epochDayStart(epoch);
  if (typeof startHourUtc !== "number" || !Number.isInteger(startHourUtc) || startHourUtc < 0 || startHourUtc > 23) {
    throw new Error("the epoch start hour (UTC, 0-23) is required and has no default");
  }
  const start = day / 1000 + startHourUtc * 3600;
  return { start, end: start + DAY };
}

// Loads the epoch's snapshots: one per evenly spaced hour, each taken at a block inside its hour.
// Only those exact files are read, so a stray snapshot cannot stand in for a missing hour, and a
// gap stops the close, because it silently shifts rewards between accounts.
export interface LoadedSnapshot {
  file: string;
  sha256: string;
  snapshot: Snapshot;
}

export function loadEpochSnapshots({
  dir,
  epoch,
  window,
  expected,
  allowPartial = false,
}: {
  dir: string;
  epoch: string;
  window: EpochWindow;
  expected: number;
  allowPartial?: boolean;
}): LoadedSnapshot[] {
  const interval = DAY / expected;
  const snapshots: LoadedSnapshot[] = [];
  const missing: string[] = [];
  for (let k = 0; k < expected; k++) {
    const target = window.start + k * interval;
    const file = `${target}.json`;
    const where = join(dir, file);
    if (!existsSync(where)) {
      missing.push(file);
      continue;
    }
    const text = readFileSync(where, "utf8");
    const s = JSON.parse(text) as Snapshot; // unchecked; the three tests below and the eligibility code check it
    if (s.format !== SNAPSHOT_FORMAT) throw new Error(`${where}: not a ${SNAPSHOT_FORMAT} snapshot`);
    if (s.target !== target) throw new Error(`${where}: was taken for ${s.target}, not ${target}`);
    const ts = s.block?.timestamp;
    if (!(ts >= target && ts < target + interval)) throw new Error(`${where}: block time ${ts} is outside its hour`);
    snapshots.push({ file, sha256: sha256(text), snapshot: s });
  }
  if (snapshots.length === 0) throw new Error(`epoch ${epoch} has no snapshots in ${dir}`);
  if (missing.length > 0 && !allowPartial) {
    throw new Error(
      `epoch ${epoch} has ${snapshots.length} of ${expected} snapshots (missing ${missing.slice(0, 3).join(", ")}` +
        `${missing.length > 3 ? ", …" : ""}); use --allow-partial to accept`,
    );
  }
  return snapshots;
}

export interface CloseEpochInput {
  dataDir: string;
  epoch: string;
  startHourUtc: number | null;
  budgets: Map<string, bigint>;
  maxHollarDebt: bigint;
  earn?: string[];
  reward: string;
  denylistPath: string;
  // Name and hash of the program file, recorded in the summary.
  program?: { name: string; sha256: string } | null;
  previousTreePath?: string | null;
  genesis?: boolean;
  allowGap?: boolean;
  expectedSnapshots?: number;
  allowPartial?: boolean;
}

export function closeEpoch({
  dataDir,
  epoch,
  startHourUtc,
  budgets,
  maxHollarDebt,
  earn,
  reward,
  denylistPath,
  program = null,
  previousTreePath = null,
  genesis = false,
  allowGap = false,
  expectedSnapshots = 24,
  allowPartial = false,
}: CloseEpochInput) {
  const window = epochWindow(epoch, startHourUtc);
  const denylist = loadDenylist(denylistPath);
  const loaded = loadEpochSnapshots({
    dir: join(dataDir, "snapshots"),
    epoch,
    window,
    expected: expectedSnapshots,
    allowPartial,
  });

  const { eligible, totals, excluded, borrowers } = epochEligibility(
    loaded.map((l) => l.snapshot),
    { maxHollarDebt, earn, denylist },
  );
  const { amounts, distributed, dust, undistributed, paidAccounts } = allocate({ eligible, totals, budgets });

  for (const account of amounts.keys()) {
    if (denylist.reasonFor(account)) throw new Error(`denylisted account ${account} would be paid`);
  }

  const csv = formatEpochCsv(amounts);
  const previous = previousTreePath ? readJson<Tree>(previousTreePath) : null;
  const tree = buildTree({ epoch, window, reward, epochAmounts: amounts, previous, genesis, allowGap });

  const summary = {
    format: EPOCH_SUMMARY_FORMAT,
    epoch,
    window,
    reward: tree.reward,
    program,
    hollarBorrowers: {
      maxDebtUsd: usdExact(maxHollarDebt),
      accounts: borrowers.accounts.size,
      removedUsdTimesSnapshots: usdExact(borrowers.value),
    },
    budgets: Object.fromEntries([...budgets].map(([k, v]) => [k, v.toString()])),
    snapshots: loaded.map((l) => ({
      file: l.file,
      block: l.snapshot.block.number,
      timestamp: l.snapshot.block.timestamp,
      sha256: l.sha256,
    })),
    partial: loaded.length !== expectedSnapshots,
    eligible: Object.fromEntries(
      [...totals].map(([k, v]) => [k, { raw: v.toString(), usdTimesSnapshots: usdExact(v) }]),
    ),
    paidAccounts: Number(paidAccounts),
    distributed: distributed.toString(),
    dust: dust.toString(),
    undistributed: Object.fromEntries([...undistributed].map(([k, v]) => [k, v.toString()])),
    denylist: {
      sha256: denylist.sha256,
      provisional: denylist.provisional,
      unresolved: denylist.unresolved,
      excluded: [...excluded.entries()].map(([account, { reason, value }]) => ({
        account,
        reason,
        usdTimesSnapshots: usdExact(value),
      })),
    },
    csv: { sha256: sha256(csv), rows: amounts.size },
    tree: {
      root: tree.root,
      previousEpoch: tree.previousEpoch,
      previousRoot: tree.previousRoot,
      accounts: tree.accounts,
      cumulative: tree.totals.cumulative,
    },
  };
  return { csv, tree, summary };
}

// Writes all outputs or none. An epoch that was closed before may only be written again with the
// same bytes: its root may already be posted, and the tree file holds the proofs for that root.
export function writeOutputs(
  outputs: [path: string, text: string][],
  { overwrite = false }: { overwrite?: boolean } = {},
): void {
  const changed = outputs.filter(([path, text]) => existsSync(path) && readFileSync(path, "utf8") !== text);
  if (changed.length > 0 && !overwrite) {
    throw new Error(
      `this epoch was already closed with a different result (${changed.map(([path]) => path).join(", ")}); ` +
        "if its root was never posted, pass --overwrite",
    );
  }
  for (const [path, text] of outputs) writeText(path, text);
}

// Closes an epoch with a loaded program and writes the CSV, summary and tree under dataDir.
export function closeEpochToDisk({
  dataDir,
  epoch,
  program,
  config,
  denylistPath,
  overwrite = false,
  ...options
}: {
  dataDir: string;
  epoch: string;
  program: Program;
  config: Config;
  denylistPath: string;
  overwrite?: boolean;
} & Pick<CloseEpochInput, "previousTreePath" | "genesis" | "allowGap" | "allowPartial">) {
  // A program loaded for closing has no blank budgets; this turns that promise into a check.
  const budgets = new Map<string, bigint>();
  for (const [asset, budget] of program.budgetPerDay) {
    if (budget === null) throw new Error(`budget_per_day for ${asset} is blank; fill it in before closing an epoch`);
    budgets.set(asset, budget);
  }
  const { csv, tree, summary } = closeEpoch({
    dataDir,
    epoch,
    startHourUtc: program.startHourUtc,
    budgets, // epochs are one day long
    maxHollarDebt: program.maxHollarDebt,
    earn: program.earn,
    reward: config.reward.address,
    denylistPath,
    program: { name: program.name, sha256: program.sha256 },
    expectedSnapshots: config.epoch.snapshotsPerEpoch,
    ...options,
  });
  const treePath = join(dataDir, "trees", `${epoch}.json`);
  const treeText = toJson(tree);
  const outputs: [string, string][] = [
    [join(dataDir, "epochs", `${epoch}.csv`), csv],
    [join(dataDir, "epochs", `${epoch}.summary.json`), toJson(summary)],
    [treePath, treeText],
  ];
  writeOutputs(outputs, { overwrite });
  return { tree, summary, treePath, treeSha256: sha256(treeText) };
}

function main() {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const { values: a } = parseArgs({
    options: {
      epoch: { type: "string" },
      program: { type: "string" },
      prev: { type: "string" },
      genesis: { type: "boolean", default: false },
      "allow-partial": { type: "boolean", default: false },
      "allow-gap": { type: "boolean", default: false },
      overwrite: { type: "boolean", default: false },
      data: { type: "string", default: join(root, "data") },
      config: { type: "string", default: join(root, "config", "mainnet.json") },
      denylist: { type: "string", default: join(root, "config", "denylist.json") },
    },
  });
  if (!a.epoch) throw new Error("--epoch is required");
  if (!a.program) throw new Error("--program is required");
  const config = readJson<Config>(a.config);
  const program = loadProgram(a.program, config, { requireDecisions: true });

  const { tree, summary } = closeEpochToDisk({
    dataDir: a.data,
    epoch: a.epoch,
    program,
    config,
    denylistPath: a.denylist,
    previousTreePath: a.prev ?? null,
    genesis: a.genesis,
    allowGap: a["allow-gap"],
    allowPartial: a["allow-partial"],
    overwrite: a.overwrite,
  });
  console.log(
    `epoch ${a.epoch}: ${summary.snapshots.length} snapshots, ${summary.csv.rows} accounts paid, ` +
      `distributed ${summary.distributed}, dust ${summary.dust}, root ${tree.root}` +
      (summary.denylist.provisional ? "\nwarning: the denylist is provisional (see config/denylist.json)" : ""),
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(`close-epoch: ${messageOf(error)}`);
    process.exit(1);
  }
}
