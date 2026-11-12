#!/usr/bin/env node
// Closes one daily epoch: stored snapshots -> eligible sums -> PRIME per account -> epochs/<epoch>.csv
// -> cumulative tree (src/build-tree.ts) on top of the previous epoch's tree.
//
// Every setting comes from the program file (programs/README.md): budgets, start hour, earning
// assets, the HOLLAR allowance, and the first epoch the file applies to.
//
// Usage:
//   node src/close-epoch.ts --epoch 2026-11-12 --program programs/htoken-no-hollar-borrowers.yaml \
//     (--prev data/trees/2026-11-11.json | --genesis)
//   --allow-partial   close with fewer than the expected snapshots (the full budget is still paid)
//   --allow-gap       build on a tree older than the day before (a day that could never be closed)
//   --overwrite       replace outputs of an earlier close that differ from this one; refused once a
//                     later epoch has been closed, because that epoch's tree builds on these outputs

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { buildTree } from "./build-tree.ts";
import { compareAddresses } from "./lib/accounts.ts";
import { addDays, epochDayStart } from "./lib/epoch.ts";
import { usdExact } from "./lib/format.ts";
import { messageOf, readJson, sha256, toJson, writeText } from "./lib/io.ts";
import { allocate } from "./allocate.ts";
import { epochEligibility, SNAPSHOT_FORMAT } from "./eligibility.ts";
import { loadDenylist } from "./lib/denylist.ts";
import { checkSelection } from "./lib/selection.ts";
import { loadProgram } from "./program.ts";
import { claimsFile, claimsPath } from "./publish.ts";
import type { Config, EpochWindow, LoadedDenylist, Program, Snapshot, Tree } from "./types.ts";

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

// Loads the epoch's snapshots: one per evenly spaced hour, each taken at the block of its hour that
// the block after the hour picks (src/lib/selection.ts). Only those exact files are read, so a stray
// snapshot cannot stand in for a missing hour, and a gap stops the close, because it silently shifts
// rewards between accounts.
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
    const s = JSON.parse(text) as Snapshot; // unchecked; the four tests below and the eligibility code check it
    if (s.format !== SNAPSHOT_FORMAT) {
      throw new Error(
        `${where}: not a ${SNAPSHOT_FORMAT} snapshot; one taken by an older version has to be taken again: ` +
          "move it aside, and the runner takes that hour again (or take it by hand with src/snapshot.ts --at)",
      );
    }
    if (s.target !== target) throw new Error(`${where}: was taken for ${s.target}, not ${target}`);
    const ts = s.block?.timestamp;
    if (!(ts >= target && ts < target + interval)) throw new Error(`${where}: block time ${ts} is outside its hour`);
    checkSelection(s.selection, s.block.number, where);
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
  denylist: LoadedDenylist;
  // Name and hash of the program file, recorded in the summary.
  program?: { name: string; sha256: string; appliesFromEpoch?: string | null } | null;
  previousTreePath?: string | null;
  genesis?: boolean;
  allowGap?: boolean;
  expectedSnapshots?: number;
  allowPartial?: boolean;
}

// The tree an epoch builds on must be the one stored for its epoch, and that tree must itself build on
// the tree stored before it. A tree passed in from elsewhere, or one whose predecessor was closed again
// after it was built, would fork the chain: the new tree would carry amounts no stored tree agrees with.
function checkStoredChain(dataDir: string, previous: Tree): void {
  const storedRoot = (epoch: string): string | null => {
    epochDayStart(epoch); // a date, before it becomes part of a path
    const path = join(dataDir, "trees", `${epoch}.json`);
    return existsSync(path) ? readJson<Tree>(path).root : null;
  };
  const stored = storedRoot(previous.epoch);
  if (stored !== previous.root) {
    throw new Error(
      stored === null
        ? `the previous tree is for ${previous.epoch}, but ${join(dataDir, "trees")} holds no tree for that epoch`
        : `the previous tree is not the one stored for ${previous.epoch} (its root is ${previous.root}, the stored one ${stored})`,
    );
  }
  if (previous.previousEpoch !== null) {
    const before = storedRoot(previous.previousEpoch);
    if (before !== previous.previousRoot) {
      throw new Error(
        `the tree for ${previous.epoch} builds on ${previous.previousEpoch} with root ${previous.previousRoot}, but ` +
          (before === null
            ? `there is no stored tree for ${previous.previousEpoch}; put it back before closing on top of ${previous.epoch}`
            : `the stored tree for ${previous.previousEpoch} has root ${before}: ${previous.previousEpoch} was closed ` +
              `again after ${previous.epoch} was built on it`),
      );
    }
  }
}

export function closeEpoch({
  dataDir,
  epoch,
  startHourUtc,
  budgets,
  maxHollarDebt,
  earn,
  reward,
  denylist,
  program = null,
  previousTreePath = null,
  genesis = false,
  allowGap = false,
  expectedSnapshots = 24,
  allowPartial = false,
}: CloseEpochInput) {
  const window = epochWindow(epoch, startHourUtc);
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
  const { amounts, distributed, dust, undistributed, earningAccounts, paidAccounts } = allocate({
    eligible,
    totals,
    budgets,
  });

  for (const account of amounts.keys()) {
    if (denylist.reasonFor(account)) throw new Error(`denylisted account ${account} would be paid`);
  }

  const csv = formatEpochCsv(amounts);
  const previous = previousTreePath ? readJson<Tree>(previousTreePath) : null;
  if (previous) checkStoredChain(dataDir, previous);
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
    // accounts that receive something, and those with any eligible value (the bound on the dust)
    paidAccounts,
    earningAccounts: Number(earningAccounts),
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

// Checks every output before writing any. An epoch that was closed before may only be written again
// with the same bytes: its root may already be posted, and the tree file holds the proofs for that root.
// Each file is written atomically, in the order given; callers put the file that marks the work as
// done last.
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

// Epochs that have a stored tree, oldest first.
export function storedTreeEpochs(dataDir: string): string[] {
  const dir = join(dataDir, "trees");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .map((f) => f.slice(0, 10))
    .sort();
}

// Where this epoch's tree goes in the stored chain, checked before anything is written.
// - It must build on the newest stored tree before it, or start the chain (--genesis) only when there
//   is none: a --genesis or --allow-gap close past a stored tree would leave that closed day out of
//   every later tree. --allow-gap is for days that have no tree.
// - Every later tree was built on this epoch's tree as it is stored. Closing this epoch again with a
//   different result, or for the first time once a later epoch is closed, would leave those trees on a
//   version of it that no longer exists, and every close after them would carry that version forward.
function checkPlaceInChain(
  dataDir: string,
  epoch: string,
  previousEpoch: string | null,
  treePath: string,
  treeText: string,
): void {
  const stored = storedTreeEpochs(dataDir);
  const earlier = stored.filter((e) => e < epoch);
  const newest = earlier.length > 0 ? earlier[earlier.length - 1] : null;
  if (newest !== previousEpoch) {
    throw new Error(
      previousEpoch === null
        ? `${newest} is already closed, so ${epoch} cannot start a new chain (--genesis): it builds on ${newest}'s tree`
        : `${epoch} would build on ${previousEpoch}, but ${newest} is closed after it, and building on an older tree ` +
            "drops the closed days in between; --allow-gap is only for days that have no tree",
    );
  }
  const later = stored.filter((e) => e > epoch);
  if (later.length === 0) return;
  const current = existsSync(treePath) ? readFileSync(treePath, "utf8") : null;
  if (current === treeText) return; // the same result again changes nothing
  const next = later[0];
  throw new Error(
    current === null
      ? `${next} is already closed without ${epoch}; closing ${epoch} now would leave it out of every later tree`
      : `${next} is already closed on top of ${epoch} as it is stored; closing ${epoch} again with a different ` +
          `result would leave ${next} and every later epoch on the old one. If none of their roots was posted, ` +
          `move the outputs of ${epoch} and of every later epoch aside, then close them again in order`,
  );
}

// A program file applies from the epoch it names (applies_from_epoch): it may not close an earlier
// epoch, and after that epoch it may only close on top of an epoch closed with this same file. So a
// new file takes over exactly at the epoch its review agreed, however early or late the runner is
// restarted with it. Returns what is wrong, or null. The runner asks before it closes anything, so a
// restart with the wrong file is reported on its first pass rather than at the next close.
export function programProblem(
  dataDir: string,
  epoch: string,
  program: Program,
  previousEpoch: string | null,
): string | null {
  const from = program.appliesFromEpoch;
  if (from === null) return "applies_from_epoch is blank; write the first epoch this file pays";
  const stored = storedTreeEpochs(dataDir);
  if (epoch < from) {
    if (!stored.some((e) => e < epoch)) {
      return (
        `epoch ${epoch} would be the first epoch, but this program file applies from ${from}: ` +
        `start with --first-epoch ${from}, or set applies_from_epoch to ${epoch}`
      );
    }
    return (
      `epoch ${epoch} is before ${from}, the first epoch this program file applies to; ` +
      "close it with the program file that applied then, or restart the runner with that file until it has"
    );
  }
  if (previousEpoch === null || previousEpoch < from) return null;
  epochDayStart(previousEpoch); // a date, before it becomes part of a path
  const path = join(dataDir, "epochs", `${previousEpoch}.summary.json`);
  const recorded = existsSync(path)
    ? readJson<{ program?: { sha256?: string; appliesFromEpoch?: string | null } | null }>(path).program
    : null;
  if (recorded?.sha256 === program.sha256) return null;
  // The file that closed it applies from a later epoch than this one: this is the older file.
  if (recorded?.appliesFromEpoch && recorded.appliesFromEpoch > from) {
    return (
      `epoch ${previousEpoch} was closed with a newer program file (${recorded.sha256}, which applies from ` +
      `${recorded.appliesFromEpoch}) than this one (applies from ${from}); restart the runner with that file`
    );
  }
  const notClosed = stored.length > 0 ? addDays(stored[stored.length - 1], 1) : epoch;
  return (
    `epoch ${previousEpoch} was closed with ${recorded?.sha256 ? `another program file (${recorded.sha256})` : "no recorded program file"}, ` +
    `but this one applies from ${from}, so it should have closed ${previousEpoch} too. If no root from ${from} ` +
    `on was posted, move the outputs of ${from} and of every later epoch (data/trees and data/epochs) aside and ` +
    `close them again in order with this file; otherwise set applies_from_epoch to ${notClosed}, the first epoch ` +
    "not closed yet. If this file is older than the one that closed it, restart the runner with that one instead"
  );
}

function checkProgramApplies(dataDir: string, epoch: string, program: Program, previousEpoch: string | null): void {
  const problem = programProblem(dataDir, epoch, program, previousEpoch);
  if (problem !== null) throw new Error(problem);
}

// Closes an epoch with a loaded program and writes the CSV, summary, claims file and tree under dataDir.
// `now` (unix seconds) only guards --allow-partial against an epoch that has not ended; it never
// reaches an output.
export function closeEpochToDisk({
  dataDir,
  epoch,
  program,
  config,
  denylist,
  overwrite = false,
  now = Math.floor(Date.now() / 1000),
  ...options
}: {
  dataDir: string;
  epoch: string;
  program: Program;
  config: Config;
  denylist: LoadedDenylist;
  overwrite?: boolean;
  now?: number;
} & Pick<CloseEpochInput, "previousTreePath" | "genesis" | "allowGap" | "allowPartial">) {
  epochDayStart(epoch);
  // A program loaded for closing has no blank budgets; this turns that promise into a check.
  const budgets = new Map<string, bigint>();
  for (const [asset, budget] of program.budgetPerDay) {
    if (budget === null) throw new Error(`budget_per_day for ${asset} is blank; fill it in before closing an epoch`);
    budgets.set(asset, budget);
  }
  checkProgramApplies(dataDir, epoch, program, null); // an epoch before the program's first one fails here
  // With hours missing, the whole budget is paid on the hours that are there: before the epoch has
  // ended that would pay a day's budget on part of a day, and the rest of its hours would never count.
  // Its last hour is only taken once it is over, so wait one hour past the end.
  const { end } = epochWindow(epoch, program.startHourUtc);
  const allowedFrom = end + DAY / config.epoch.snapshotsPerEpoch;
  if (options.allowPartial && now < allowedFrom) {
    throw new Error(
      `epoch ${epoch} ends at ${new Date(end * 1000).toISOString()} and its last hour is taken just after; ` +
        `--allow-partial is accepted from ${new Date(allowedFrom * 1000).toISOString()}`,
    );
  }
  const { csv, tree, summary } = closeEpoch({
    dataDir,
    epoch,
    startHourUtc: program.startHourUtc,
    budgets, // epochs are one day long
    maxHollarDebt: program.maxHollarDebt,
    earn: program.earn,
    reward: config.reward.address,
    denylist,
    program: { name: program.name, sha256: program.sha256, appliesFromEpoch: program.appliesFromEpoch },
    expectedSnapshots: config.epoch.snapshotsPerEpoch,
    ...options,
  });
  checkProgramApplies(dataDir, epoch, program, tree.previousEpoch);
  const treePath = join(dataDir, "trees", `${epoch}.json`);
  const treeText = toJson(tree);
  checkPlaceInChain(dataDir, epoch, tree.previousEpoch, treePath, treeText);
  // The claims file goes first: it depends only on the tree and is named after its root, so if a close
  // stops after it, the leftover is never fetched. The tree goes last: the runner takes it as the sign
  // that the epoch is closed, so a close cut off before it is done again and writes the same bytes.
  const outputs: [string, string][] = [
    // What the app claims from. An older root's file is never removed.
    [claimsPath(dataDir, tree.root), toJson(claimsFile(tree))],
    [join(dataDir, "epochs", `${epoch}.csv`), csv],
    [join(dataDir, "epochs", `${epoch}.summary.json`), toJson(summary)],
    [treePath, treeText],
  ];
  if (!overwrite && !existsSync(treePath)) {
    const changed = outputs.filter(([path, text]) => existsSync(path) && readFileSync(path, "utf8") !== text);
    if (changed.length > 0) {
      throw new Error(
        `${changed.map(([path]) => path).join(", ")} differ from this close, and ${epoch} has no tree: either ` +
          "an earlier close stopped before writing it (it produced no root, so pass --overwrite), or the tree " +
          "was removed by hand (put it back instead)",
      );
    }
  }
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
    denylist: loadDenylist(a.denylist),
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
