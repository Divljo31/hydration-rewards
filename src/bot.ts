#!/usr/bin/env node
// The runner: keeps the hourly snapshots and the daily epochs up to date.
//
// Every tick it works out what is due from the files under the data directory alone, and does it,
// oldest first:
//   1. the snapshot of every hour that has ended since the start of the open epoch, the one after the
//      newest tree (an hour's block is picked by the block after it, so an hour is taken once it is over)
//   2. the close of every epoch whose snapshots are all there, each on the tree of the day before
//   3. public/latest.json, which tells the app who is earning as of the newest snapshot, and the
//      newest tree's claims file if it is missing
// There is no other state, so a restart, a crash or a day of downtime is caught up on the next tick
// (as long as the RPC node still has the state of the missed hours). A failure in one step does not
// stop the steps that do not depend on it: a snapshot that fails stops the snapshots, but epochs whose
// hours are all in are still closed. Every failure is reported and tried again on the next tick, and
// nothing is skipped.
//
// The program file is read once, at start, and a new one takes effect at its applies_from_epoch: every
// tick checks the loaded file against the stored epochs before it closes anything, so a restart with
// the wrong file is reported at once. The denylist is read on every tick, so a change to it applies
// from the next close. One runner per data directory: it holds <data>/bot.lock while it runs.
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
import { closeEpochToDisk, epochWindow, programProblem } from "./close-epoch.ts";
import { addDays, epochDayStart } from "./lib/epoch.ts";
import { loadDenylist } from "./lib/denylist.ts";
import { acquireLock, loadDotEnv, messageOf, readJson, sha256, toJson, writeText } from "./lib/io.ts";
import { makeRpc } from "./lib/rpc.ts";
import { loadProgram, parseProgram } from "./program.ts";
import { claimsFile, claimsPath, latestFile, latestPath, publishLatest } from "./publish.ts";
import { snapshotHour } from "./snapshot.ts";
import type { Config, LoadedDenylist, Log, Program, Snapshot, Tree } from "./types.ts";

const DAY = 86_400;
const iso = (seconds: number): string => new Date(seconds * 1000).toISOString();

// One pass. `takeHour(target)` takes and stores the snapshot of one hour.
// A pass that fails throws, and the error carries this status as `status`.
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
  // the denylist this pass read, or null when it could not be read
  denylist: { sha256: string; provisional: boolean } | null;
  // why nothing more could be done, if anything is outstanding
  waiting: string | null;
  // hours the chain produced no block in
  blocked: string[];
}

// The claims file of every stored tree, written again where it is missing: the app fetches the one of
// whatever root the URD holds, which is an older tree's for at least 12 hours after each close. The
// root comes from each epoch's summary, so a tree is only read when its file has to be written.
function restoreClaimsFiles(dataDir: string, epochs: string[], log: Log): void {
  for (const epoch of epochs) {
    const summaryPath = join(dataDir, "epochs", `${epoch}.summary.json`);
    const root = existsSync(summaryPath) ? readJson<{ tree?: { root?: string } }>(summaryPath).tree?.root : undefined;
    if (root !== undefined && existsSync(claimsPath(dataDir, root))) continue;
    const tree = readJson<Tree>(join(dataDir, "trees", `${epoch}.json`));
    if (existsSync(claimsPath(dataDir, tree.root))) continue;
    writeText(claimsPath(dataDir, tree.root), toJson(claimsFile(tree)));
    log(`wrote the missing claims file of ${epoch}'s root ${tree.root}`);
  }
}

export async function tick({
  now,
  dataDir,
  program,
  config,
  denylistPath,
  firstEpoch,
  takeHour,
  pendingProgramFrom = null,
  knownDenylist = null,
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
  // applies_from_epoch of a program file waiting on disk: the loaded file closes nothing from there on
  pendingProgramFrom?: string | null;
  // the denylist hash the last pass used, so a change is logged before a close uses it
  knownDenylist?: string | null;
  maxBacklog?: number;
  log?: Log;
}): Promise<TickStatus> {
  epochDayStart(firstEpoch);
  // A tree from before the first epoch means the date is wrong: starting over from genesis here
  // would build a cumulative tree without the earlier epochs' amounts.
  const treesDir = join(dataDir, "trees");
  const trees = existsSync(treesDir)
    ? readdirSync(treesDir)
        .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
        .sort()
    : [];
  const earlier = trees.filter((f) => f < `${firstEpoch}.json`);
  if (earlier.length > 0) {
    throw new Error(
      `the first epoch is ${firstEpoch}, but ${treesDir} already holds ${earlier[0]}; check the first epoch`,
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

  // The open epoch is the one after the newest tree: the chain goes on from its head, past any day
  // that was skipped by hand with --allow-gap.
  const newestTree = trees.length > 0 ? trees[trees.length - 1].slice(0, 10) : null;
  let epoch = newestTree === null ? firstEpoch : addDays(newestTree, 1);

  // A failure in one step does not stop the steps that do not depend on it. They are all reported
  // together at the end of the tick, which then counts as failed.
  const failures: Error[] = [];
  const fail = (what: string, error: unknown) =>
    failures.push(new Error(`${what}: ${messageOf(error)}`, { cause: error }));

  // What closing needs besides the snapshots. Without either, this pass closes nothing and leaves
  // latest.json alone, but still takes the snapshots that are due.
  let denylist: LoadedDenylist | null = null;
  try {
    denylist = loadDenylist(denylistPath);
    if (knownDenylist !== null && denylist.sha256 !== knownDenylist) {
      log(
        `denylist changed to ${denylist.sha256}${denylist.provisional ? " (provisional)" : ""}; ` +
          "the closes from this pass on use it",
      );
    }
  } catch (error) {
    fail("denylist", error);
  }
  const programIssue = programProblem(dataDir, epoch, program, newestTree);
  if (programIssue !== null) failures.push(new Error(`program: ${programIssue}`));
  const canClose = denylist !== null && programIssue === null;

  // 1. Snapshots, for every hour from the open epoch's start that has ended by now.
  const due: number[] = [];
  for (let target = hoursOf(epoch)[0]; target + interval <= now; target += interval) {
    if (!hasSnapshot(target)) due.push(target);
  }
  if (due.length > maxBacklog) {
    const error = new Error(
      `${due.length} snapshots are overdue since ${iso(due[0])}, more than the ${maxBacklog} this runner catches up on ` +
        "its own; check the first epoch, or take them by hand with src/snapshot.ts",
    );
    throw Object.assign(error, { status: { openEpoch: epoch } });
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
        waiting = `the hour from ${iso(target)} is not over and finalized yet`;
        break; // later hours cannot be finalized either
      }
      // The chain produced no block inside this hour, so it can never be snapshotted. Later hours
      // are still taken; the epoch stays open until someone closes it by hand with --allow-partial.
      if (code === "NO_BLOCK_IN_HOUR") {
        blocked.push(target);
        continue;
      }
      // Anything else stops the snapshots. Epochs whose hours are all in are still closed below.
      fail(`snapshot of ${iso(target)}`, error);
      break;
    }
    taken.push(target);
    log(`snapshot ${iso(target)}`);
  }

  // 2. Closes, for every epoch that now has all its snapshots.
  const closed: TickStatus["closed"] = [];
  if (canClose && denylist !== null) {
    try {
      while (hoursOf(epoch).every(hasSnapshot)) {
        // A merged program file waits on disk: from its first epoch on, the loaded file must not close.
        if (pendingProgramFrom !== null && epoch >= pendingProgramFrom) {
          failures.push(
            new Error(
              `program: the program file on disk applies from ${pendingProgramFrom}; ` +
                `restart the runner with it to close ${epoch}`,
            ),
          );
          break;
        }
        const genesis = epoch === firstEpoch;
        const { tree, summary, treeSha256 } = closeEpochToDisk({
          dataDir,
          epoch,
          program,
          config,
          denylist,
          now,
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
    } catch (error) {
      fail(`close of ${epoch}`, error);
    }
  }
  const stuck = blocked.filter((target) => hoursOf(epoch).includes(target));
  if (stuck.length > 0) {
    // --allow-partial pays the whole budget on the hours there are, so it waits until every other
    // hour of the epoch is in, which is just after the epoch ends (the closer waits an hour past it).
    const { end } = epochWindow(epoch, program.startHourUtc);
    const hours = stuck.map(iso).join(", ");
    const ready = now >= end + interval && hoursOf(epoch).every((h) => stuck.includes(h) || hasSnapshot(h));
    waiting = ready
      ? `epoch ${epoch} cannot close on its own: the chain produced no block inside ${hours}; ` +
        "close it by hand with --allow-partial"
      : `the chain produced no block inside ${hours}, so epoch ${epoch} cannot close on its own; once its other ` +
        `hours are all taken, from ${iso(end + interval)}, close it by hand with --allow-partial`;
  }

  const latest = addDays(epoch, -1);
  let latestTree: TickStatus["latestTree"] = null;
  if (existsSync(treePath(latest))) {
    const text = readFileSync(treePath(latest), "utf8");
    latestTree = { epoch: latest, root: (JSON.parse(text) as Tree).root, sha256: sha256(text) };
  }
  // A close writes each claims file before its tree; a tree closed by an older version, copied in, or
  // whose public folder was lost gets its file here.
  try {
    const stored = existsSync(treesDir)
      ? readdirSync(treesDir)
          .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
          .map((f) => f.slice(0, 10))
      : [];
    restoreClaimsFiles(dataDir, stored, log);
  } catch (error) {
    fail("claims files", error);
  }

  // 3. What the app reads. Rebuilt when this pass changed something, when the file is not there yet,
  // or when another program file wrote it (after a restart with a new one).
  const publishedBy = (): string | undefined => {
    try {
      return readJson<{ program?: { sha256?: string } }>(latestPath(dataDir)).program?.sha256;
    } catch {
      return undefined;
    }
  };
  if (
    canClose &&
    denylist !== null &&
    (taken.length > 0 || closed.length > 0 || !existsSync(latestPath(dataDir)) || publishedBy() !== program.sha256)
  ) {
    const first = hoursOf(firstEpoch)[0];
    let newest = first + Math.floor((now - first) / interval) * interval;
    while (newest >= first && !hasSnapshot(newest)) newest -= interval;
    if (newest >= first) {
      try {
        publishLatest(
          dataDir,
          latestFile({
            snapshot: readJson<Snapshot>(join(dataDir, "snapshots", `${newest}.json`)),
            program,
            reward: config.reward,
            denylist,
            latestTree: latestTree && { epoch: latestTree.epoch, root: latestTree.root },
          }),
        );
      } catch (error) {
        fail("public/latest.json", error);
      }
    }
  }

  const status: TickStatus = {
    openEpoch: epoch,
    snapshots: hoursOf(epoch).filter(hasSnapshot).length,
    taken,
    closed,
    latestTree,
    denylist: denylist && { sha256: denylist.sha256, provisional: denylist.provisional },
    waiting,
    blocked: blocked.map(iso),
  };
  if (failures.length > 0) {
    const error =
      failures.length === 1 ? failures[0] : new AggregateError(failures, failures.map(messageOf).join("; also "));
    throw Object.assign(error, { status });
  }
  return status;
}

// The program file on disk when it is not the one this runner loaded: a merged change waiting for a
// restart. Restart once the epoch before its applies_from_epoch is closed, and before that one closes.
export function programOnDisk(
  path: string,
  config: Config,
  loaded: Program,
): { sha256?: string; appliesFromEpoch?: string | null; error?: string } | null {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    return { error: messageOf(error) };
  }
  const onDisk = sha256(text);
  if (onDisk === loaded.sha256) return null;
  try {
    return { sha256: onDisk, appliesFromEpoch: parseProgram(text, config, { source: path }).appliesFromEpoch };
  } catch (error) {
    return { sha256: onDisk, error: messageOf(error) };
  }
}

// The epoch from which the loaded file must stop closing: the applies_from_epoch of a program file on
// disk that takes over later than the loaded one. A file that would not (an edit that kept the date,
// an older file put back) is only reported: it would be refused anyway, and the loaded one keeps running.
export function pendingProgramFrom(onDisk: ReturnType<typeof programOnDisk>, loaded: Program): string | null {
  const from = onDisk?.appliesFromEpoch;
  return from && loaded.appliesFromEpoch !== null && from > loaded.appliesFromEpoch ? from : null;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const root = fileURLToPath(new URL("..", import.meta.url));
  loadDotEnv(root);
  const env = process.env;
  const { values: a } = parseArgs({
    options: {
      "first-epoch": { type: "string", default: env.FIRST_EPOCH },
      program: { type: "string", default: env.PROGRAM || join(root, "programs", "htoken-no-hollar-borrowers.yaml") },
      data: { type: "string", default: env.DATA_DIR || join(root, "data") },
      interval: { type: "string", default: env.BOT_INTERVAL_SECONDS || "60" },
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
  // Budgets, the start hour and the program's first epoch must be decided before anything is paid,
  // so a blank stops the start. A denylist that does not load stops it too; it is read again every tick.
  const program = loadProgram(a.program, config, { requireDecisions: true });
  const startDenylist = loadDenylist(a.denylist);
  const rpc = makeRpc(a.rpc || env.RPC_HYDRATION || config.rpc, { batchSize: config.rpcBatchSize });
  const log: Log = (line) => console.log(`${new Date().toISOString()} ${line}`);
  const takeHour = (target: number) => snapshotHour({ rpc, config, dataDir: a.data, target, log });
  const statusPath = join(a.data, "status.json");

  // Two runners on one data directory would race on the holder index and on every output. The lock is
  // released on exit, which the signals below go through; every write is atomic, so stopping mid-tick is safe.
  acquireLock(join(a.data, "bot.lock"), `the data directory ${a.data}`);
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(signal, () => process.exit(0));
  log(
    `program "${program.name}" (${program.sha256}) applies from ${program.appliesFromEpoch}; ` +
      `denylist ${startDenylist.sha256}${startDenylist.provisional ? " (provisional)" : ""}; ` +
      `first epoch ${a["first-epoch"]}, data in ${a.data}`,
  );

  let lastProblem: string | null = null;
  let lastDenylist = startDenylist.sha256;
  let lastOnDisk = "null";
  for (;;) {
    // A merged program file on disk stops the loaded one from closing its epochs (see tick).
    const onDisk = programOnDisk(a.program, config, program);
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
        pendingProgramFrom: pendingProgramFrom(onDisk, program),
        knownDenylist: lastDenylist,
        log,
      });
    } catch (error) {
      problem = messageOf(error);
      status = (error as { status?: TickStatus }).status ?? {};
    }
    // The same failure every minute is logged once, and again when it clears.
    if (problem !== lastProblem) log(problem ? `FAILED, will retry: ${problem}` : "recovered");
    lastProblem = problem;
    if (status.denylist) lastDenylist = status.denylist.sha256;
    if (JSON.stringify(onDisk) !== lastOnDisk) {
      lastOnDisk = JSON.stringify(onDisk);
      if (onDisk !== null) {
        log(
          `the program file on disk is not the one running (${onDisk.sha256 ?? onDisk.error}); ` +
            (pendingProgramFrom(onDisk, program) !== null
              ? `it applies from ${onDisk.appliesFromEpoch}, and the running file closes nothing from there on: ` +
                "restart once the epoch before it is closed"
              : onDisk.appliesFromEpoch
                ? `it applies from ${onDisk.appliesFromEpoch}, no later than the running file ` +
                  `(${program.appliesFromEpoch}), so it cannot take over as it is: every change moves ` +
                  "applies_from_epoch to an epoch that is not closed yet"
                : `it cannot be used: ${onDisk.error ?? "applies_from_epoch is blank"}`),
        );
      }
    }
    writeText(
      statusPath,
      toJson({
        tickedAt: new Date().toISOString(),
        program: { name: program.name, sha256: program.sha256, appliesFromEpoch: program.appliesFromEpoch },
        programOnDisk: onDisk,
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
