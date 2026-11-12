// The runner's tick against a data directory, with snapshots supplied by the test instead of a chain.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { pendingProgramFrom, programOnDisk, tick } from "../src/bot.ts";
import type { TickStatus } from "../src/bot.ts";
import { closeEpochToDisk, epochWindow } from "../src/close-epoch.ts";
import { loadDenylist } from "../src/lib/denylist.ts";
import { sha256, toJson } from "../src/lib/io.ts";
import { parseProgram } from "../src/program.ts";
import { ACCOUNTS, makeDataDir, makeSnapshot, parseCsv } from "./helpers.ts";
import type { DenylistFile } from "../src/lib/denylist.ts";
import type { Tree } from "../src/types.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const config = JSON.parse(readFileSync(join(root, "config", "mainnet.json"), "utf8"));
const FIRST = "2026-11-12";
const { start } = epochWindow(FIRST, 14);
const HOUR = 3600;

const programText = ({ husdt = 1, from = FIRST } = {}) => `name: bot test
applies_from_epoch: ${from}
budget_per_day:
  HUSDC: 1
  HUSDT: ${husdt}
epoch_start_hour_utc: 14
earn_on_supply_of: [HUSDC, HUSDT]
max_hollar_debt_usd: 5
`;
const PROGRAM = programText();
const program = parseProgram(PROGRAM, config, { requireDecisions: true });
const programOf = (options: Parameters<typeof programText>[0]) =>
  parseProgram(programText(options), config, { requireDecisions: true });

// What a failed pass did, which it carries on the error it throws.
const statusOf = (error: unknown): TickStatus => (error as { status: TickStatus }).status;

// A runner over an empty data directory. Each hour's snapshot holds one account, a on even days of
// the month and b on odd ones, so the trees show which epochs were closed. An hour is due once it
// has ended, so at `start + k * HOUR` the hours before k have been asked for.
function runner({
  failAt = null,
  notFinalizedFrom = Infinity,
  noBlockAt = null,
  denylist = undefined,
}: {
  failAt?: number | null;
  notFinalizedFrom?: number;
  noBlockAt?: number | null;
  denylist?: DenylistFile;
} = {}) {
  const { dataDir, denylistPath } = makeDataDir({ snapshots: [], ...(denylist ? { denylist } : {}) });
  const asked: number[] = [];
  const takeHour = async (target: number) => {
    asked.push(target);
    if (target >= notFinalizedFrom) throw Object.assign(new Error("no finalized block yet"), { code: "NOT_FINALIZED" });
    if (target === failAt) throw new Error("eth_call: execution reverted");
    if (target === noBlockAt) throw Object.assign(new Error("no block in this hour"), { code: "NO_BLOCK_IN_HOUR" });
    writeHour(target);
  };
  const writeHour = (target: number) => {
    const account = new Date((target - 14 * HOUR) * 1000).getUTCDate() % 2 === 0 ? ACCOUNTS.a : ACCOUNTS.b;
    const snapshot = makeSnapshot({
      number: target / 6,
      timestamp: target + 2,
      target,
      accounts: { [account]: { husdt: 10 } },
    });
    writeFileSync(join(dataDir, "snapshots", `${target}.json`), toJson(snapshot));
  };
  const run = (now: number, extra: Partial<Parameters<typeof tick>[0]> = {}) =>
    tick({ now, dataDir, program, config, denylistPath, firstEpoch: FIRST, takeHour, ...extra });
  const tree = (epoch: string): Tree => JSON.parse(readFileSync(join(dataDir, "trees", `${epoch}.json`), "utf8"));
  return { dataDir, denylistPath, asked, run, tree, writeHour };
}

test("nothing happens before the first epoch starts", async () => {
  const { asked, run } = runner();
  const status = await run(start - 1);
  assert.deepEqual(asked, []);
  assert.equal(status.openEpoch, FIRST);
  assert.match(String(status.waiting), /first epoch starts at 2026-11-12T14:00:00/);
});

test("each hour is snapshotted once it has ended, and an epoch is closed when its last hour is in", async () => {
  const { dataDir, denylistPath, asked, run, tree } = runner();

  // An hour's block is picked by the first block after it, so the hour still running is not asked for.
  let status = await run(start + 3 * HOUR + 59);
  assert.deepEqual(asked, [start, start + HOUR, start + 2 * HOUR]);
  assert.deepEqual(status, {
    openEpoch: FIRST,
    snapshots: 3,
    taken: asked,
    closed: [],
    latestTree: null,
    denylist: { sha256: loadDenylist(denylistPath).sha256, provisional: false },
    waiting: null,
    blocked: [],
  });

  status = await run(start + 3 * HOUR + 119); // a minute later: nothing new is due
  assert.equal(asked.length, 3);
  assert.deepEqual(status.taken, []);

  status = await run(start + 24 * HOUR); // the 24th hour has ended
  assert.equal(asked.length, 24);
  assert.equal(status.closed.length, 1);
  assert.equal(status.closed[0].epoch, FIRST);
  assert.equal(status.closed[0].distributed, "1000000");
  assert.equal(status.closed[0].paidAccounts, 1);
  assert.equal(status.openEpoch, "2026-11-13");
  assert.equal(status.snapshots, 0);
  assert.deepEqual(status.latestTree, { epoch: FIRST, root: tree(FIRST).root, sha256: status.closed[0].treeSha256 });
  assert.equal(tree(FIRST).previousRoot, null); // the first epoch is the genesis tree
  assert.deepEqual([...parseCsv(readFileSync(join(dataDir, "epochs", `${FIRST}.csv`), "utf8")).keys()], [ACCOUNTS.a]);
});

test("after downtime it catches up: missed hours first, then every finished epoch in order", async () => {
  const { asked, run, tree } = runner();
  await run(start + 5 * HOUR);
  // Down for two days, back at hour 50: hours 5 to 49 have ended since.
  const status = await run(start + 50 * HOUR + 10);
  assert.equal(asked.length, 50);
  assert.deepEqual(
    asked,
    [...asked].sort((x, y) => x - y),
  ); // oldest first
  assert.deepEqual(
    status.closed.map((c) => c.epoch),
    ["2026-11-12", "2026-11-13"],
  );
  assert.equal(status.openEpoch, "2026-11-14");
  assert.equal(status.snapshots, 2);
  // Each tree builds on the day before, and carries its accounts forward.
  assert.equal(tree("2026-11-13").previousRoot, tree("2026-11-12").root);
  assert.equal(tree("2026-11-13").claims[ACCOUNTS.a].claimable, "1000000");
  assert.equal(tree("2026-11-13").claims[ACCOUNTS.b].claimable, "1000000");
});

test("a failed snapshot stops the snapshots and fails the tick; the next tick carries on from the same hour", async () => {
  const failing = runner({ failAt: start + 10 * HOUR });
  await assert.rejects(
    failing.run(start + 30 * HOUR),
    /snapshot of 2026-11-13T00:00:00.000Z: eth_call: execution reverted/,
  );
  assert.equal(failing.asked.at(-1), start + 10 * HOUR);
  assert.equal(existsSync(join(failing.dataDir, "trees")), false); // nothing closed with an hour missing

  const { asked, run } = runner();
  await run(start + 9 * HOUR);
  const status = await run(start + 30 * HOUR);
  assert.equal(asked.length, 30);
  assert.equal(status.closed.length, 1);
});

test("a failed snapshot in a later epoch does not hold up closing an epoch whose hours are all in", async () => {
  // Back after downtime at hour 30; hour 26, in the second epoch, cannot be read.
  const { dataDir, asked, run, tree } = runner({ failAt: start + 26 * HOUR });
  await assert.rejects(run(start + 30 * HOUR), (error) => {
    assert.match(
      String((error as Error).message),
      /snapshot of 2026-11-13T16:00:00.000Z: eth_call: execution reverted/,
    );
    // The failed pass still says what it did, for status.json.
    const status = statusOf(error);
    assert.deepEqual(
      status.closed.map((c) => c.epoch),
      [FIRST],
    );
    assert.equal(status.openEpoch, "2026-11-13");
    assert.equal(status.latestTree?.root, tree(FIRST).root);
    return true;
  });
  assert.equal(asked.at(-1), start + 26 * HOUR);
  assert.ok(existsSync(join(dataDir, "trees", `${FIRST}.json`)), "the complete first epoch was closed");
  assert.equal(tree(FIRST).claims[ACCOUNTS.a].claimable, "1000000");
  assert.equal(existsSync(join(dataDir, "trees", "2026-11-13.json")), false);
});

test("an hour whose block is not finalized yet is waited for, not reported as a failure", async () => {
  const { asked, run } = runner({ notFinalizedFrom: start + 3 * HOUR });
  // Hours 3 and 4 have both ended; once 3 is not finalized, 4 cannot be either and is not tried.
  const status = await run(start + 5 * HOUR);
  assert.deepEqual(status.taken, [start, start + HOUR, start + 2 * HOUR]);
  assert.match(String(status.waiting), /the hour from 2026-11-12T17:00:00.000Z is not over and finalized yet/);
  assert.equal(asked.at(-1), start + 3 * HOUR);
});

test("a backlog larger than the limit is refused, so a wrong first epoch cannot start a year of snapshots", async () => {
  const { asked, run } = runner();
  await assert.rejects(run(start + 400 * HOUR), (error) => {
    assert.match(String((error as Error).message), /400 snapshots are overdue since 2026-11-12T14:00:00.000Z/);
    assert.equal(statusOf(error).openEpoch, FIRST, "status.json still says which epoch is open");
    return true;
  });
  assert.deepEqual(asked, []);
  await assert.rejects(run(start, { firstEpoch: "12 Nov" }), /must be a date like 2026-11-12/);
});

// The runner as its own process, with one --once pass.
function botProcess(data: string, ...args: string[]) {
  return spawnSync(
    process.execPath,
    [join(root, "src", "bot.ts"), "--once", "--data", data, "--rpc", "http://127.0.0.1:1", ...args],
    {
      encoding: "utf8",
      env: { ...process.env, FIRST_EPOCH: "", PROGRAM: "" },
    },
  );
}

test("the bot refuses to start without a first epoch or with a program whose decisions are blank", () => {
  const data = mkdtempSync(join(tmpdir(), "hydration-rewards-"));
  const noEpoch = botProcess(data);
  assert.equal(noEpoch.status, 1);
  assert.match(noEpoch.stderr, /--first-epoch \(or FIRST_EPOCH\) is required/);

  // A program file whose decisions are not all made, as the shipped one is until launch. (Not the
  // shipped file itself: a pull request that fills it in must not turn this test red.)
  const undecided = join(data, "undecided.yaml");
  writeFileSync(undecided, PROGRAM.replace("HUSDT: 1", "HUSDT:"));
  const blank = botProcess(data, "--first-epoch", FIRST, "--program", undecided);
  assert.equal(blank.status, 1);
  assert.match(blank.stderr, /budget_per_day for HUSDT is blank; fill it in before closing an epoch/);

  // With decisions made and an epoch that has not started, one tick writes the status file and exits.
  const programPath = join(data, "program.yaml");
  writeFileSync(programPath, PROGRAM);
  const idle = botProcess(data, "--first-epoch", "2999-01-01", "--program", programPath);
  assert.equal(idle.status, 0, idle.stderr);
  const status = JSON.parse(readFileSync(join(data, "status.json"), "utf8"));
  assert.equal(status.error, null);
  assert.equal(status.openEpoch, "2999-01-01");
  assert.equal(status.program.appliesFromEpoch, FIRST);
  assert.equal(status.programOnDisk, null);
  assert.match(status.denylist.sha256, /^0x[0-9a-f]{64}$/);
  assert.match(String(status.waiting), /first epoch starts at 2999-01-01T14:00:00/);

  // A denylist that does not load stops the start instead of the first close.
  const brokenDenylist = join(data, "denylist.json");
  writeFileSync(brokenDenylist, toJson({ addresses: [{ address: ACCOUNTS.a }] }));
  const broken = botProcess(
    data,
    "--first-epoch",
    "2999-01-01",
    "--program",
    programPath,
    "--denylist",
    brokenDenylist,
  );
  assert.equal(broken.status, 1);
  assert.match(broken.stderr, /every address needs a label/);
});

test("one runner per data directory; a lock left by a runner that is gone is taken over", () => {
  const data = mkdtempSync(join(tmpdir(), "hydration-rewards-"));
  const programPath = join(data, "program.yaml");
  writeFileSync(programPath, PROGRAM);
  const once = () => botProcess(data, "--first-epoch", "2999-01-01", "--program", programPath);
  const lock = join(data, "bot.lock");

  // A runner that is running: this test's own process, which the spawned runner is not.
  writeFileSync(lock, JSON.stringify({ pid: process.pid, host: hostname(), token: "running" }));
  const refused = once();
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, new RegExp(`in use by process ${process.pid} on`));
  assert.equal(existsSync(join(data, "status.json")), false);

  const gone = spawnSync(process.execPath, ["-e", ""]).pid; // has exited by now
  writeFileSync(lock, JSON.stringify({ pid: gone, host: hostname(), token: "crashed" }));
  const ran = once();
  assert.equal(ran.status, 0, ran.stderr);
  assert.equal(existsSync(lock), false, "the lock is released on exit");
});

test("the runner releases its lock when it is stopped with SIGTERM, SIGINT or SIGHUP", async () => {
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
    const data = mkdtempSync(join(tmpdir(), "hydration-rewards-"));
    const programPath = join(data, "program.yaml");
    writeFileSync(programPath, PROGRAM);
    const child = spawn(
      process.execPath,
      [join(root, "src", "bot.ts"), "--data", data, "--rpc", "http://127.0.0.1:1"].concat([
        "--first-epoch",
        "2999-01-01",
        "--program",
        programPath,
        "--interval",
        "3600",
      ]),
      { env: { ...process.env, FIRST_EPOCH: "", PROGRAM: "" }, stdio: "ignore" },
    );
    const exited = new Promise((resolve) => child.once("exit", resolve));
    // Its first pass writes status.json; then it holds the lock and sleeps.
    for (let i = 0; i < 200 && !existsSync(join(data, "status.json")); i++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(existsSync(join(data, "bot.lock")), `${signal}: the lock is held while the runner runs`);
    child.kill(signal);
    await exited;
    assert.equal(existsSync(join(data, "bot.lock")), false, `${signal}: the lock is released`);
  }
});

test("a failed pass still writes what it knows to status.json", () => {
  const data = mkdtempSync(join(tmpdir(), "hydration-rewards-"));
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  const programPath = join(data, "program.yaml");
  writeFileSync(programPath, programText({ from: yesterday }));
  // The node cannot be reached, so the first hour that is due fails.
  const failed = botProcess(data, "--first-epoch", yesterday, "--program", programPath);
  assert.equal(failed.status, 1);
  const status = JSON.parse(readFileSync(join(data, "status.json"), "utf8"));
  assert.match(status.error, /snapshot of .*: 127\.0\.0\.1:1 unreachable after 4 attempts/);
  assert.equal(status.openEpoch, yesterday);
  assert.deepEqual(status.taken, []);
  assert.match(status.denylist.sha256, /^0x[0-9a-f]{64}$/);
});

test("an hour the chain produced no block in does not stop later hours, and leaves its epoch for a person to close", async () => {
  const { dataDir, asked, run } = runner({ noBlockAt: start + 5 * HOUR });
  // Before its other hours are all taken, closing it by hand would pay the whole budget on part of the day.
  const early = await run(start + 10 * HOUR);
  assert.match(
    String(early.waiting),
    /no block inside 2026-11-12T19:00:00.000Z, so epoch 2026-11-12 cannot close on its own; once its other hours are all taken, from 2026-11-13T15:00:00.000Z, close it by hand with --allow-partial/,
  );
  // Just after the epoch's end: the hours are in, but the closer only accepts --allow-partial an hour later.
  const justAfter = await run(start + 24 * HOUR + 30);
  assert.match(String(justAfter.waiting), /once its other hours are all taken, from 2026-11-13T15:00:00.000Z/);

  asked.length = 0;
  const status = await run(start + 30 * HOUR);
  assert.equal(asked.length, 7); // every hour that has ended was tried, the stalled one again each pass
  assert.equal(status.taken.length, 6);
  assert.deepEqual(status.blocked, ["2026-11-12T19:00:00.000Z"]);
  assert.equal(status.openEpoch, FIRST);
  assert.equal(status.closed.length, 0);
  assert.match(
    String(status.waiting),
    /epoch 2026-11-12 cannot close on its own: .* close it by hand with --allow-partial/,
  );
  assert.equal(existsSync(join(dataDir, "trees")), false);
});

test("after a day skipped by hand with --allow-gap, the runner carries on from the newest tree", async () => {
  const { dataDir, denylistPath, asked, run, tree, writeHour } = runner();
  await run(start + 24 * HOUR); // closes 2026-11-12
  // 2026-11-13 could never be closed; a person closed 2026-11-14 on 2026-11-12's tree.
  for (let k = 48; k < 72; k++) writeHour(start + k * HOUR);
  closeEpochToDisk({
    dataDir,
    epoch: "2026-11-14",
    program,
    config,
    denylist: loadDenylist(denylistPath),
    previousTreePath: join(dataDir, "trees", `${FIRST}.json`),
    allowGap: true,
  });
  asked.length = 0;
  const status = await run(start + 96 * HOUR);
  assert.deepEqual(
    status.closed.map((c) => c.epoch),
    ["2026-11-15"],
  );
  assert.equal(asked[0], start + 72 * HOUR, "the skipped day's hours are not asked for");
  assert.equal(tree("2026-11-15").previousRoot, tree("2026-11-14").root);
});

test("a first epoch later than trees that already exist is refused instead of starting over from genesis", async () => {
  const { run } = runner();
  await run(start + 24 * HOUR); // closes 2026-11-12
  // Restarted with the date read as "resume from here".
  await assert.rejects(
    run(start + 49 * HOUR, { firstEpoch: "2026-11-13" }),
    /already holds 2026-11-12\.json; check the first epoch/,
  );
  // With the right date the same restart simply carries on.
  const status = await run(start + 49 * HOUR);
  assert.deepEqual(
    status.closed.map((c) => c.epoch),
    ["2026-11-13"],
  );
});

test("a program file closes nothing before its applies_from_epoch, and the runner says so on its first pass", async () => {
  const { dataDir, asked, run } = runner();
  const later = programOf({ from: "2026-11-13" });
  // Three hours in, a day before the close would be refused, the pass already fails.
  await assert.rejects(run(start + 3 * HOUR, { program: later }), (error) => {
    assert.match(
      String((error as Error).message),
      /program: epoch 2026-11-12 would be the first epoch, but this program file applies from 2026-11-13: start with --first-epoch 2026-11-13, or set applies_from_epoch to 2026-11-12/,
    );
    assert.equal(statusOf(error).taken.length, 3, "the hours are still taken");
    return true;
  });
  await assert.rejects(run(start + 24 * HOUR, { program: later }), /applies from 2026-11-13/);
  assert.equal(asked.length, 24);
  assert.equal(existsSync(join(dataDir, "trees")), false);
});

test("a new program file takes over at its applies_from_epoch, and a changed file needs a new one", async () => {
  const { run, tree } = runner();
  await run(start + 24 * HOUR); // 2026-11-12 with the first file

  // Reviewed to pay twice the HUSDT budget from 2026-11-13; the runner was restarted with it in time.
  const doubled = programOf({ husdt: 2, from: "2026-11-13" });
  const second = await run(start + 48 * HOUR, { program: doubled });
  assert.deepEqual(
    second.closed.map((c) => [c.epoch, c.distributed]),
    [["2026-11-13", "2000000"]],
  );
  assert.equal(tree("2026-11-13").claims[ACCOUNTS.b].claimable, "2000000");

  // The file edited again without moving applies_from_epoch: 2026-11-13 was closed with the earlier
  // version, so this one would apply to a day that has already been paid differently. The first pass
  // after the restart says so, an hour into 2026-11-14 rather than when it closes.
  const edited = programOf({ husdt: 3, from: "2026-11-13" });
  await assert.rejects(
    run(start + 49 * HOUR, { program: edited }),
    /program: epoch 2026-11-13 was closed with another program file .* set applies_from_epoch to 2026-11-14/,
  );
  const fromNextDay = programOf({ husdt: 3, from: "2026-11-14" });
  const third = await run(start + 72 * HOUR, { program: fromNextDay });
  assert.deepEqual(
    third.closed.map((c) => [c.epoch, c.distributed]),
    [["2026-11-14", "3000000"]],
  );
});

test("the denylist is read on every pass: a change applies from the next close, and one that does not load stops the closes", async () => {
  const { dataDir, denylistPath, asked, run } = runner();
  await run(start + 24 * HOUR); // 2026-11-12 pays a
  const before = loadDenylist(denylistPath).sha256;

  // b, who holds everything on 2026-11-13, is listed while the runner keeps running.
  writeFileSync(
    denylistPath,
    toJson({ rules: { palletAccounts: true }, addresses: [{ address: ACCOUNTS.b, label: "test entry" }] }),
  );
  const lines: string[] = [];
  const listed = await run(start + 48 * HOUR, { knownDenylist: before, log: (line) => lines.push(line) });
  assert.equal(listed.denylist?.sha256, loadDenylist(denylistPath).sha256);
  // The change is logged before the close that uses it.
  const changed = lines.findIndex((line) => line.startsWith(`denylist changed to ${listed.denylist?.sha256}`));
  const closedLine = lines.findIndex((line) => line.startsWith("epoch 2026-11-13 closed"));
  assert.ok(changed >= 0 && changed < closedLine, lines.join("\n"));
  assert.deepEqual(
    listed.closed.map((c) => [c.epoch, c.paidAccounts]),
    [["2026-11-13", 0]],
  );
  const summary = JSON.parse(readFileSync(join(dataDir, "epochs", "2026-11-13.summary.json"), "utf8"));
  assert.deepEqual(
    summary.denylist.excluded.map((e: { account: string }) => e.account),
    [ACCOUNTS.b],
  );

  // A denylist that cannot be read: no close and no latest.json on a stale list, but the hours go on.
  const latest = () => JSON.parse(readFileSync(join(dataDir, "public", "latest.json"), "utf8"));
  const shown = latest().asOf.hour;
  writeFileSync(denylistPath, "{ not json");
  await assert.rejects(run(start + 49 * HOUR), (error) => {
    assert.match(String((error as Error).message), /^denylist: /);
    assert.equal(statusOf(error).denylist, null);
    return true;
  });
  assert.equal(asked.at(-1), start + 48 * HOUR);
  assert.equal(latest().asOf.hour, shown, "latest.json stays as it was while the denylist is broken");
});

test("while a newer program file waits on disk, the running one closes nothing from its applies_from_epoch on", async () => {
  const { dataDir, run } = runner();
  await assert.rejects(run(start + 48 * HOUR, { pendingProgramFrom: "2026-11-13" }), (error) => {
    assert.match(
      String((error as Error).message),
      /program: the program file on disk applies from 2026-11-13; restart the runner with it to close 2026-11-13/,
    );
    assert.deepEqual(
      statusOf(error).closed.map((c) => c.epoch),
      [FIRST],
    );
    return true;
  });
  assert.equal(existsSync(join(dataDir, "trees", "2026-11-13.json")), false);
});

test("latest.json is rebuilt when the runner restarts with another program file", async () => {
  const { dataDir, run } = runner();
  await run(start + 3 * HOUR);
  const latest = () => JSON.parse(readFileSync(join(dataDir, "public", "latest.json"), "utf8"));
  assert.equal(latest().program.sha256, program.sha256);
  const other = programOf({ husdt: 2 });
  await run(start + 3 * HOUR + 30, { program: other }); // nothing new is due
  assert.equal(latest().program.sha256, other.sha256);
  assert.equal(latest().assets.HUSDT.budgetPerDay, "2000000");
});

test("a failed close still publishes latest.json, two failures are both reported, and a latest.json failure fails the pass", async () => {
  // Hour 5's file is unreadable as a snapshot of hour 5, so 2026-11-12 cannot close.
  const { dataDir, run, writeHour } = runner({ failAt: start + 26 * HOUR });
  await run(start + 23 * HOUR);
  writeFileSync(join(dataDir, "snapshots", `${start + 5 * HOUR}.json`), toJson({ format: "something-else" }));
  const latest = () => JSON.parse(readFileSync(join(dataDir, "public", "latest.json"), "utf8"));

  await assert.rejects(run(start + 24 * HOUR), /close of 2026-11-12: .* not a hydration-rewards-snapshot\/2 snapshot/);
  assert.equal(latest().asOf.hour, start + 23 * HOUR, "latest.json moved on to the hour taken in the failed pass");

  // A snapshot failure and a close failure in one pass are both reported.
  await assert.rejects(run(start + 30 * HOUR), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.errors.length, 2);
    assert.match(error.message, /snapshot of 2026-11-13T16:00:00.000Z: .*; also close of 2026-11-12: /);
    return true;
  });

  // latest.json that cannot be written fails the pass too.
  writeHour(start + 5 * HOUR); // the epoch can close again
  rmSync(join(dataDir, "public", "latest.json"));
  mkdirSync(join(dataDir, "public", "latest.json", "in-the-way"), { recursive: true });
  await assert.rejects(run(start + 26 * HOUR), /public\/latest\.json: /);
});

test("every stored tree's claims file is written again if it is missing", async () => {
  // The URD holds an older root for at least 12 hours after each close, so the app needs older files too.
  const { dataDir, run, tree } = runner();
  await run(start + 48 * HOUR);
  const claims = (epoch: string) => join(dataDir, "public", "trees", `${tree(epoch).root}.json`);
  const original = readFileSync(claims(FIRST), "utf8");
  rmSync(claims(FIRST));
  rmSync(claims("2026-11-13"));
  const lines: string[] = [];
  await run(start + 48 * HOUR + 60, { log: (line) => lines.push(line) });
  assert.equal(readFileSync(claims(FIRST), "utf8"), original);
  assert.ok(existsSync(claims("2026-11-13")));
  assert.match(lines.join("\n"), /wrote the missing claims file of 2026-11-12's root/);
});

test("a provisional denylist is called out next to the root to post", async () => {
  const lines: string[] = [];
  const provisional = { rules: { palletAccounts: true }, addresses: [], unresolved: ["ICE pot"] };
  const status = await runner({ denylist: provisional }).run(start + 24 * HOUR, { log: (line) => lines.push(line) });
  assert.equal(status.closed[0].denylistProvisional, true);
  assert.match(
    lines.join("\n"),
    /to post: submitRoot\(0x[0-9a-f]{64}, 0x[0-9a-f]{64}\)\n\s+WARNING: the denylist is provisional/,
  );

  const clean: string[] = [];
  await runner().run(start + 24 * HOUR, { log: (line) => clean.push(line) });
  assert.doesNotMatch(clean.join("\n"), /WARNING/);
});

test("only a program file that takes over later than the running one stops the running one's closes", () => {
  const loaded = parseProgram(PROGRAM, config, { requireDecisions: true }); // applies from 2026-11-12
  const onDisk = (appliesFromEpoch: string | null) => ({ sha256: "0xother", appliesFromEpoch });
  assert.equal(pendingProgramFrom(onDisk("2026-11-20"), loaded), "2026-11-20");
  // An edit that kept the date, or an older file put back: reported, but the runner keeps closing.
  assert.equal(pendingProgramFrom(onDisk(FIRST), loaded), null);
  assert.equal(pendingProgramFrom(onDisk("2026-11-01"), loaded), null);
  assert.equal(pendingProgramFrom(onDisk(null), loaded), null);
  assert.equal(pendingProgramFrom({ error: "ENOENT" }, loaded), null);
  assert.equal(pendingProgramFrom(null, loaded), null);
});

test("a program file on disk that is not the one running is reported with the epoch it applies from", () => {
  const dir = mkdtempSync(join(tmpdir(), "hydration-program-"));
  const path = join(dir, "program.yaml");
  writeFileSync(path, PROGRAM);
  const loaded = parseProgram(PROGRAM, config, { requireDecisions: true });
  assert.equal(programOnDisk(path, config, loaded), null);

  const merged = programText({ husdt: 2, from: "2026-11-20" });
  writeFileSync(path, merged);
  assert.deepEqual(programOnDisk(path, config, loaded), { sha256: sha256(merged), appliesFromEpoch: "2026-11-20" });

  writeFileSync(path, "name: broken\nbudget_per_day: 1\n");
  assert.match(String(programOnDisk(path, config, loaded)?.error), /"earn_on_supply_of" is missing/);
  rmSync(path);
  assert.match(String(programOnDisk(path, config, loaded)?.error), /ENOENT/);
});

test("the runner publishes who is earning as of the newest snapshot, and the tree of each closed epoch", async () => {
  const { dataDir, run, tree } = runner();
  const latest = () => JSON.parse(readFileSync(join(dataDir, "public", "latest.json"), "utf8"));

  await run(start + 3 * HOUR + 30); // hours 0 to 2 have ended
  assert.equal(latest().asOf.hour, start + 2 * HOUR);
  assert.deepEqual(latest().accounts, { [ACCOUNTS.a]: { earning: true, hollarDebtUsd: "0.00" } });
  assert.equal(latest().latestTree, null);
  assert.equal(existsSync(join(dataDir, "public", "trees")), false);

  // A pass with nothing new leaves the file alone; if the file is lost, the next pass restores it.
  const before = readFileSync(join(dataDir, "public", "latest.json"), "utf8");
  await run(start + 3 * HOUR + 90);
  assert.equal(readFileSync(join(dataDir, "public", "latest.json"), "utf8"), before);
  rmSync(join(dataDir, "public", "latest.json"));
  await run(start + 3 * HOUR + 150);
  assert.equal(readFileSync(join(dataDir, "public", "latest.json"), "utf8"), before);

  // Closing the epoch publishes its tree under the root, and the status file points at it.
  await run(start + 25 * HOUR); // hour 24, the first of the next epoch, has ended too
  const closedRoot = tree(FIRST).root;
  assert.deepEqual(latest().latestTree, { epoch: FIRST, root: closedRoot });
  assert.equal(latest().asOf.hour, start + 24 * HOUR);
  assert.deepEqual(
    Object.keys(JSON.parse(readFileSync(join(dataDir, "public", "trees", `${closedRoot}.json`), "utf8")).claims),
    [ACCOUNTS.a],
  );
  // The runner's own status, which can carry RPC error text, is not in the public folder.
  assert.deepEqual(readdirSync(join(dataDir, "public")).sort(), ["latest.json", "trees"]);
});
