#!/usr/bin/env node
// The runner: keeps the hourly snapshots and the daily epochs up to date.
//
// Every tick it works out what is due from the files under the data directory alone, and does it,
// oldest first:
//   1. the snapshot of every hour since the start of the first epoch that is not closed yet
//   2. the close of every epoch whose snapshots are all there, each on the tree of the day before
// There is no other state, so a restart, a crash or a day of downtime is caught up on the next tick
// (as long as the RPC node still has the state of the missed hours). Anything that fails stops the
// tick and is tried again on the next one; nothing is skipped.
//
// It does not post roots. After each close it prints what the root-posting key has to submit.
//
// Usage:
//   node src/bot.ts --first-epoch 2027-01-15 [--program programs/htoken-no-hollar-borrowers.yaml]
//     [--data data] [--interval 60] [--once]
// Environment, used when the flag is not given: FIRST_EPOCH, PROGRAM, DATA_DIR, BOT_INTERVAL_SECONDS,
// RPC_HYDRATION. A .env file in the repository root is read too (see .env.example).

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { closeEpochToDisk, epochWindow } from "./close-epoch.ts";
import { addDays, epochDayStart } from "./lib/epoch.ts";
import { loadDotEnv, messageOf, readJson, sha256, toJson, writeText } from "./lib/io.ts";
import { makeRpc } from "./lib/rpc.ts";
import { loadProgram } from "./program.ts";
import { snapshotHour } from "./snapshot.ts";
import type { Config, Log, Program, Tree } from "./types.ts";

const DAY = 86_400;
const iso = (seconds: number): string => new Date(seconds * 1000).toISOString();

// One pass. `takeHour(target)` takes and stores the snapshot of one hour.
// Returns { openEpoch, snapshots, taken, closed, latestTree, waiting, blocked }.
export interface TickStatus {
  // the first epoch without a tree, and how many of its snapshots exist
  openEpoch: string;
  snapshots: number;
  // what this pass did
  taken: number[];
  closed: {
    epoch: string;
    root: string;
    treeSha256: string;
    paidAccounts: number;
    distributed: string;
    denylistProvisional: boolean;
  }[];
  latestTree: { epoch: string; root: string; sha256: string } | null;
  // why nothing more could be done, if anything is outstanding
  waiting: string | null;
  // hours the chain produced no block in
  blocked: string[];
}

export async function tick({
  now,
  dataDir,
  program,
  config,
  denylistPath,
  firstEpoch,
  takeHour,
  maxBacklog = 72,
  log = () => {},
}: {
  now: number;
  dataDir: string;
  program: Program;
  config: Config;
  denylistPath: string;
  firstEpoch: string;
  takeHour: (target: number) => Promise<unknown>;
  maxBacklog?: number;
  log?: Log;
}): Promise<TickStatus> {
  epochDayStart(firstEpoch);
  // A tree from before the first epoch means the date is wrong: starting over from genesis here
  // would build a cumulative tree without the earlier epochs' amounts.
  const treesDir = join(dataDir, "trees");
  const earlier = existsSync(treesDir)
    ? readdirSync(treesDir).filter((f) => f.endsWith(".json") && f < `${firstEpoch}.json`)
    : [];
  if (earlier.length > 0) {
    throw new Error(
      `the first epoch is ${firstEpoch}, but ${treesDir} already holds ${earlier.sort()[0]}; check the first epoch`,
    );
  }
  const perEpoch = config.epoch.snapshotsPerEpoch;
  const interval = DAY / perEpoch;
  const treePath = (epoch: string): string => join(dataDir, "trees", `${epoch}.json`);
  const hasSnapshot = (target: number): boolean => existsSync(join(dataDir, "snapshots", `${target}.json`));
  const hoursOf = (epoch: string): number[] => {
    const { start } = epochWindow(epoch, program.startHourUtc);
    return Array.from({ length: perEpoch }, (_, k) => start + k * interval);
  };

  // The open epoch is the first one without a tree.
  let epoch = firstEpoch;
  while (existsSync(treePath(epoch))) epoch = addDays(epoch, 1);

  // 1. Snapshots, for every hour from the open epoch's start up to now.
  const due: number[] = [];
  for (let target = hoursOf(epoch)[0]; target <= now; target += interval) {
    if (!hasSnapshot(target)) due.push(target);
  }
  if (due.length > maxBacklog) {
    throw new Error(
      `${due.length} snapshots are overdue since ${iso(due[0])}, more than the ${maxBacklog} this runner catches up on ` +
        "its own; check the first epoch, or take them by hand with src/snapshot.ts",
    );
  }
  const taken: number[] = [];
  const blocked: number[] = [];
  let waiting: string | null =
    now < hoursOf(firstEpoch)[0] ? `the first epoch starts at ${iso(hoursOf(firstEpoch)[0])}` : null;
  for (const target of due) {
    try {
      await takeHour(target);
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      if (code === "NOT_FINALIZED") {
        waiting = `the block for ${iso(target)} is not finalized yet`;
        break; // later hours cannot be finalized either
      }
      // The chain produced no block inside this hour, so it can never be snapshotted. Later hours
      // are still taken; the epoch stays open until someone closes it by hand with --allow-partial.
      if (code !== "NO_BLOCK_IN_HOUR") throw error;
      blocked.push(target);
      continue;
    }
    taken.push(target);
    log(`snapshot ${iso(target)}`);
  }

  // 2. Closes, for every epoch that now has all its snapshots.
  const closed: TickStatus["closed"] = [];
  while (hoursOf(epoch).every(hasSnapshot)) {
    const genesis = epoch === firstEpoch;
    const { tree, summary, treeSha256 } = closeEpochToDisk({
      dataDir,
      epoch,
      program,
      config,
      denylistPath,
      genesis,
      previousTreePath: genesis ? null : treePath(addDays(epoch, -1)),
    });
    closed.push({
      epoch,
      root: tree.root,
      treeSha256,
      paidAccounts: summary.paidAccounts,
      distributed: summary.distributed,
      denylistProvisional: summary.denylist.provisional,
    });
    log(
      `epoch ${epoch} closed: ${summary.csv.rows} accounts paid, distributed ${summary.distributed}, dust ${summary.dust}\n` +
        `  to post: submitRoot(${tree.root}, ${treeSha256})` +
        (summary.denylist.provisional
          ? "\n  WARNING: the denylist is provisional, so accounts that should earn nothing may be in this tree"
          : ""),
    );
    epoch = addDays(epoch, 1);
  }
  const stuck = blocked.filter((target) => hoursOf(epoch).includes(target));
  if (stuck.length > 0) {
    waiting =
      `epoch ${epoch} cannot close on its own: the chain produced no block inside ${stuck.map(iso).join(", ")}; ` +
      "close it by hand with --allow-partial";
  }

  const latest = addDays(epoch, -1);
  let latestTree: TickStatus["latestTree"] = null;
  if (existsSync(treePath(latest))) {
    const text = readFileSync(treePath(latest), "utf8");
    latestTree = { epoch: latest, root: (JSON.parse(text) as Tree).root, sha256: sha256(text) };
  }
  return {
    openEpoch: epoch,
    snapshots: hoursOf(epoch).filter(hasSnapshot).length,
    taken,
    closed,
    latestTree,
    waiting,
    blocked: blocked.map(iso),
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const root = fileURLToPath(new URL("..", import.meta.url));
  loadDotEnv(root);
  const env = process.env;
  const { values: a } = parseArgs({
    options: {
      "first-epoch": { type: "string", default: env.FIRST_EPOCH },
      program: { type: "string", default: env.PROGRAM ?? join(root, "programs", "htoken-no-hollar-borrowers.yaml") },
      data: { type: "string", default: env.DATA_DIR ?? join(root, "data") },
      interval: { type: "string", default: env.BOT_INTERVAL_SECONDS ?? "60" },
      once: { type: "boolean", default: false },
      config: { type: "string", default: join(root, "config", "mainnet.json") },
      denylist: { type: "string", default: join(root, "config", "denylist.json") },
      rpc: { type: "string" },
    },
  });
  if (!a["first-epoch"])
    throw new Error("--first-epoch (or FIRST_EPOCH) is required: the date of the very first epoch");
  const intervalSeconds = Number(a.interval);
  if (!(intervalSeconds >= 1)) throw new Error(`--interval must be a number of seconds, got ${a.interval}`);

  const config = readJson<Config>(a.config);
  // Budgets and the start hour must be decided before anything is paid, so a blank stops the start.
  const program = loadProgram(a.program, config, { requireDecisions: true });
  const rpc = makeRpc(a.rpc ?? env.RPC_HYDRATION ?? config.rpc, { batchSize: config.rpcBatchSize });
  const log: Log = (line) => console.log(`${new Date().toISOString()} ${line}`);
  const takeHour = (target: number) => snapshotHour({ rpc, config, dataDir: a.data, target, log });
  const statusPath = join(a.data, "status.json");

  process.on("SIGTERM", () => process.exit(0)); // every write is atomic, so stopping mid-tick is safe
  log(`program "${program.name}" (${program.sha256}), first epoch ${a["first-epoch"]}, data in ${a.data}`);

  let lastProblem: string | null = null;
  for (;;) {
    let status: Partial<TickStatus> = {};
    let problem: string | null = null;
    try {
      status = await tick({
        now: Math.floor(Date.now() / 1000),
        dataDir: a.data,
        program,
        config,
        denylistPath: a.denylist,
        firstEpoch: a["first-epoch"],
        takeHour,
        log,
      });
    } catch (error) {
      problem = messageOf(error);
    }
    // The same failure every minute is logged once, and again when it clears.
    if (problem !== lastProblem) log(problem ? `FAILED, will retry: ${problem}` : "recovered");
    lastProblem = problem;
    writeText(
      statusPath,
      toJson({
        tickedAt: new Date().toISOString(),
        program: { name: program.name, sha256: program.sha256 },
        firstEpoch: a["first-epoch"],
        ...status,
        error: problem,
      }),
    );
    if (a.once) process.exit(problem ? 1 : 0);
    await sleep(intervalSeconds * 1000);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`bot: ${messageOf(error)}`);
    process.exit(1);
  });
}
