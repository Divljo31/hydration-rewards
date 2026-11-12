import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { closeEpoch, closeEpochToDisk, epochWindow, writeOutputs } from "../src/close-epoch.ts";
import type { CloseEpochInput } from "../src/close-epoch.ts";
import type { Config, Tree } from "../src/types.ts";
import { allocate } from "../src/allocate.ts";
import { loadDenylist } from "../src/lib/denylist.ts";
import { toJson, writeText } from "../src/lib/io.ts";
import { parseProgram } from "../src/program.ts";
import { $, ACCOUNTS, hashOf, hourly, makeDataDir, makeSnapshot, parseCsv } from "./helpers.ts";

const PRIME = "0x000000000000000000000000000000010000002b";
const EPOCH = "2026-11-12";
const START_HOUR = 14;
const { start } = epochWindow(EPOCH, START_HOUR);
const BUDGETS = new Map([
  ["HUSDC", 1_000_000n],
  ["HUSDT", 1_000_000n],
]);
const config = JSON.parse(
  readFileSync(join(fileURLToPath(new URL("..", import.meta.url)), "config", "mainnet.json"), "utf8"),
) as Config;

function close(dataDir: string, denylistPath: string, overrides: Partial<CloseEpochInput> = {}) {
  return closeEpoch({
    dataDir,
    epoch: EPOCH,
    startHourUtc: START_HOUR,
    budgets: BUDGETS,
    maxHollarDebt: $(5),
    reward: PRIME,
    denylist: loadDenylist(denylistPath),
    genesis: true,
    ...overrides,
  });
}

// Stores a tree where the runner keeps it, which is where a close looks for the chain it extends.
function storeTree(dataDir: string, tree: Tree): string {
  const path = join(dataDir, "trees", `${tree.epoch}.json`);
  writeText(path, toJson(tree));
  return path;
}

test("the epoch window starts at the given UTC hour and has no default", () => {
  assert.equal(new Date(start * 1000).toISOString(), "2026-11-12T14:00:00.000Z");
  assert.throws(() => epochWindow(EPOCH, undefined), /required and has no default/);
  assert.throws(() => epochWindow(EPOCH, 24), /required and has no default/);
});

test("an account that leaves mid-epoch earns for the hours it held", () => {
  // A holds $100k for 12 hours, B holds $50k for 24 hours: equal time-weighted balances.
  const { dataDir, denylistPath } = makeDataDir({
    snapshots: hourly(start, (h) => ({
      [ACCOUNTS.a]: { husdt: h < 12 ? 100_000 : 0 },
      [ACCOUNTS.b]: { husdt: 50_000 },
    })),
  });
  const { csv, summary } = close(dataDir, denylistPath);
  const paid = parseCsv(csv);
  assert.equal(paid.get(ACCOUNTS.a), 500_000n);
  assert.equal(paid.get(ACCOUNTS.b), 500_000n);
  // Nobody held HUSDC, so its budget is reported rather than spread over HUSDT holders.
  assert.deepEqual(summary.undistributed, { HUSDC: "1000000" });
});

test("a HOLLAR borrower earns only for the hours without the debt; debt within the allowance is ignored", () => {
  // a borrows $1,000 HOLLAR for the first 12 hours; b carries $3 of HOLLAR dust all day.
  const { dataDir, denylistPath } = makeDataDir({
    snapshots: hourly(start, (h) => ({
      [ACCOUNTS.a]: { husdt: 100_000, hollar: h < 12 ? 1_000 : 0 },
      [ACCOUNTS.b]: { husdt: 50_000, hollar: 3 },
    })),
  });
  // With $5 allowed, a earns for 12 hours at $100k and b for 24 hours at $50k: equal shares.
  const withAllowance = close(dataDir, denylistPath);
  assert.equal(parseCsv(withAllowance.csv).get(ACCOUNTS.a), 500_000n);
  assert.equal(parseCsv(withAllowance.csv).get(ACCOUNTS.b), 500_000n);
  assert.deepEqual(withAllowance.summary.hollarBorrowers, {
    maxDebtUsd: "5.00",
    accounts: 1,
    removedUsdTimesSnapshots: "1200000.00",
  });
  // With no allowance b's dust disqualifies it all day: a gets all of HUSDT's budget.
  const strict = close(dataDir, denylistPath, { maxHollarDebt: 0n });
  assert.deepEqual([...parseCsv(strict.csv).entries()], [[ACCOUNTS.a, 1_000_000n]]);
});

test("re-running on the same snapshots gives byte-identical CSV, summary and root", () => {
  const { dataDir, denylistPath } = makeDataDir({
    snapshots: hourly(start, (h) => ({
      [ACCOUNTS.a]: { husdc: 1_234 + h, husdt: 777, hollar: h % 3 },
      [ACCOUNTS.b]: { husdt: 99_999, hollarGigahdx: 12_345 },
      [ACCOUNTS.c]: { husdc: 3, husdt: 5 },
    })),
  });
  const first = close(dataDir, denylistPath);
  const second = close(dataDir, denylistPath);
  assert.equal(second.csv, first.csv);
  assert.equal(toJson(second.summary), toJson(first.summary));
  assert.equal(second.tree.root, first.tree.root);
});

test("the CSV sums to the budget minus dust smaller than the number of accounts", () => {
  const accounts = Object.fromEntries(
    Array.from({ length: 37 }, (_, i) => [
      `0x${(i + 1).toString(16).padStart(40, "0")}`,
      { husdc: 7 * i + 3, husdt: 11 * i + 1, hollar: i % 5 },
    ]),
  );
  const { dataDir, denylistPath } = makeDataDir({ snapshots: hourly(start, () => accounts) });
  const budgets = new Map([
    ["HUSDC", 275_616_001n],
    ["HUSDT", 275_615_999n],
  ]);
  const { csv, summary } = close(dataDir, denylistPath, { budgets });
  const paid = parseCsv(csv);
  const total = [...paid.values()].reduce((x, y) => x + y, 0n);
  const dust = 275_616_001n + 275_615_999n - total;
  assert.equal(String(total), summary.distributed);
  assert.equal(String(dust), summary.dust);
  // Every account with eligible value loses less than one unit, including one whose share rounds to nothing.
  assert.ok(
    dust >= 0n && dust < BigInt(summary.earningAccounts),
    `dust ${dust} vs ${summary.earningAccounts} accounts`,
  );
  assert.equal(summary.paidAccounts, paid.size);
  assert.equal(summary.paidAccounts, summary.csv.rows);
});

test("an account whose share rounds down to nothing is earning but not paid", () => {
  // a holds a billion times b's balance, and the budget is one unit short of paying b anything.
  const { dataDir, denylistPath } = makeDataDir({
    snapshots: hourly(start, () => ({ [ACCOUNTS.a]: { husdt: 1_000_000_000 }, [ACCOUNTS.b]: { husdt: 1 } })),
  });
  const { csv, summary } = close(dataDir, denylistPath, { budgets: new Map([...BUDGETS, ["HUSDT", 1_000n]]) });
  assert.deepEqual([...parseCsv(csv).keys()], [ACCOUNTS.a]);
  assert.equal(summary.paidAccounts, 1);
  assert.equal(summary.earningAccounts, 2);
});

test("no denylisted account appears in the CSV", () => {
  const { dataDir, denylistPath } = makeDataDir({
    snapshots: hourly(start, () => ({
      [ACCOUNTS.a]: { husdt: 1_000 },
      [ACCOUNTS.treasury]: { husdc: 400_000, husdt: 400_000 },
      [ACCOUNTS.listed]: { husdt: 50_000 },
    })),
    denylist: {
      rules: { palletAccounts: true },
      addresses: [{ address: ACCOUNTS.listed, label: "test entry" }],
      unresolved: ["ICE pot"],
    },
  });
  const { csv, summary } = close(dataDir, denylistPath);
  assert.deepEqual([...parseCsv(csv).keys()], [ACCOUNTS.a]);
  assert.equal(summary.denylist.provisional, true);
  assert.deepEqual(summary.denylist.excluded.map((e) => e.account).sort(), [ACCOUNTS.listed, ACCOUNTS.treasury].sort());
});

test("the closer needs one snapshot for every hour of the epoch", () => {
  const holdings = () => ({ [ACCOUNTS.a]: { husdt: 10 } });
  const base = hourly(start, holdings);

  const missing = makeDataDir({ snapshots: base.filter((_, h) => h !== 5) });
  assert.throws(() => close(missing.dataDir, missing.denylistPath), /has 23 of 24 snapshots \(missing \d+\.json\)/);
  const partial = close(missing.dataDir, missing.denylistPath, { allowPartial: true });
  assert.equal(partial.summary.partial, true);
  assert.equal(partial.summary.snapshots.length, 23);

  // A snapshot taken off the hour cannot stand in for the missing one.
  const stray = makeSnapshot({ number: 9_000, timestamp: start + 5 * 3600 + 60, accounts: holdings() });
  makeDataDir({ snapshots: [stray], into: missing.dataDir });
  assert.throws(() => close(missing.dataDir, missing.denylistPath), /has 23 of 24 snapshots/);

  const empty = makeDataDir({ snapshots: [] });
  assert.throws(() => close(empty.dataDir, empty.denylistPath, { allowPartial: true }), /has no snapshots/);
});

test("24 snapshots taken within one minute do not make an epoch", () => {
  const clustered = Array.from({ length: 24 }, (_, i) =>
    makeSnapshot({ number: 1_000 + i, timestamp: start + i, accounts: { [ACCOUNTS.a]: { husdt: 10 } } }),
  );
  const { dataDir, denylistPath } = makeDataDir({ snapshots: clustered });
  assert.throws(() => close(dataDir, denylistPath), /has 1 of 24 snapshots/);
});

test("a snapshot must have been taken for its hour, at a block inside that hour", () => {
  const holdings = () => ({ [ACCOUNTS.a]: { husdt: 10 } });

  // The chain stalled: the first block at or after 19:00 only came at 20:00.
  const late = hourly(start, holdings);
  late[5].block.timestamp = start + 6 * 3600;
  const l = makeDataDir({ snapshots: late });
  assert.throws(() => close(l.dataDir, l.denylistPath), /is outside its hour/);

  // A file renamed into another hour's slot.
  const renamed = hourly(start, holdings);
  const r = makeDataDir({ snapshots: renamed.filter((_, h) => h !== 5) });
  const copy = makeSnapshot({
    number: 7_777,
    timestamp: start + 4 * 3600 + 30,
    target: start + 4 * 3600,
    accounts: holdings(),
  });
  writeFileSync(join(r.dataDir, "snapshots", `${start + 5 * 3600}.json`), toJson(copy));
  assert.throws(() => close(r.dataDir, r.denylistPath), /was taken for/);

  const wrongFormat = hourly(start, holdings);
  wrongFormat[0].format = "something-else";
  const w = makeDataDir({ snapshots: wrongFormat });
  assert.throws(() => close(w.dataDir, w.denylistPath), /not a hydration-rewards-snapshot/);
});

test("budgets are required for every reserve", () => {
  const eligible = new Map([
    [
      ACCOUNTS.a,
      new Map([
        ["HUSDC", 1n],
        ["HUSDT", 1n],
      ]),
    ],
  ]);
  const totals = new Map([
    ["HUSDC", 1n],
    ["HUSDT", 1n],
  ]);
  assert.throws(() => allocate({ eligible, totals, budgets: new Map([["HUSDC", 5n]]) }), /no budget given for HUSDT/);
});

test("each epoch builds on the tree of the day before; skipping a day is refused", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "hydration-rewards-"));
  const days = { "2026-11-12": ACCOUNTS.a, "2026-11-13": ACCOUNTS.b, "2026-11-14": ACCOUNTS.c };
  let denylistPath = "";
  for (const [epoch, account] of Object.entries(days)) {
    const s = epochWindow(epoch, START_HOUR).start;
    ({ denylistPath } = makeDataDir({
      snapshots: hourly(s, () => ({ [account]: { husdt: 10 } }), Number(epoch.slice(-2)) * 1_000),
      into: dataDir,
    }));
  }
  // closeEpoch reads the previous tree from disk, as the CLI does, and checks it is the stored one.
  const treePath = (_epoch: string, tree: Tree) => storeTree(dataDir, tree);

  const e12 = close(dataDir, denylistPath);
  assert.throws(() => close(dataDir, denylistPath, { genesis: false }), /previous tree is required/);
  const p12 = treePath("2026-11-12", e12.tree);
  const e13 = close(dataDir, denylistPath, { epoch: "2026-11-13", genesis: false, previousTreePath: p12 });
  assert.equal(e13.tree.previousRoot, e12.tree.root);
  assert.equal(e13.tree.claims[ACCOUNTS.a].claimable, "1000000"); // carried over
  assert.equal(e13.tree.claims[ACCOUNTS.b].claimable, "1000000");

  // Closing 11-14 on 11-12's tree would drop what b earned on 11-13.
  assert.throws(
    () => close(dataDir, denylistPath, { epoch: "2026-11-14", genesis: false, previousTreePath: p12 }),
    /drops the rewards of the days in between/,
  );
  const e14 = close(dataDir, denylistPath, {
    epoch: "2026-11-14",
    genesis: false,
    previousTreePath: treePath("2026-11-13", e13.tree),
  });
  assert.equal(e14.tree.claims[ACCOUNTS.b].claimable, "1000000");
  assert.equal(e14.summary.tree.previousEpoch, "2026-11-13");

  // The explicit override is recorded in the summary.
  const gap = close(dataDir, denylistPath, {
    epoch: "2026-11-14",
    genesis: false,
    previousTreePath: p12,
    allowGap: true,
  });
  assert.equal(gap.summary.tree.previousEpoch, "2026-11-12");
});

test("outputs of an epoch that was already closed are never replaced by different ones", () => {
  const dir = mkdtempSync(join(tmpdir(), "hydration-rewards-"));
  const tree = join(dir, "trees", "2026-11-12.json");
  const csv = join(dir, "epochs", "2026-11-12.csv");
  writeOutputs([
    [csv, "account,amount\n"],
    [tree, "first\n"],
  ]);
  assert.equal(readFileSync(tree, "utf8"), "first\n");

  // The same bytes again are fine: closing is repeatable.
  assert.doesNotThrow(() =>
    writeOutputs([
      [csv, "account,amount\n"],
      [tree, "first\n"],
    ]),
  );

  // A different tree is refused, and nothing else is written either.
  const summary = join(dir, "epochs", "2026-11-12.summary.json");
  assert.throws(
    () =>
      writeOutputs([
        [summary, "{}\n"],
        [csv, "account,amount\n"],
        [tree, "second\n"],
      ]),
    /already closed with a different result/,
  );
  assert.equal(readFileSync(tree, "utf8"), "first\n");
  assert.equal(existsSync(summary), false);

  writeOutputs([[tree, "second\n"]], { overwrite: true });
  assert.equal(readFileSync(tree, "utf8"), "second\n");
});

test("changing the start hour between epochs is refused, because hours would be counted twice or never", () => {
  const holdings = () => ({ [ACCOUNTS.a]: { husdt: 10 } });
  const first = makeDataDir({ snapshots: hourly(start, holdings) });
  const e12 = close(first.dataDir, first.denylistPath);
  assert.deepEqual(e12.tree.window, { start, end: start + 86_400 });
  const prev = storeTree(first.dataDir, e12.tree);

  // The next day closed with start hour 10 instead of 14: its window begins four hours early.
  const early = epochWindow("2026-11-13", 10).start;
  makeDataDir({ snapshots: hourly(early, holdings, 5_000), into: first.dataDir });
  assert.throws(
    () =>
      close(first.dataDir, first.denylistPath, {
        epoch: "2026-11-13",
        startHourUtc: 10,
        genesis: false,
        previousTreePath: prev,
      }),
    /must follow each other without a gap or an overlap/,
  );
  assert.throws(() => epochWindow("2026-11-31", 14), /must be a date like/);
});

test("a snapshot must be at the block its hour's seed block picks", () => {
  const holdings = () => ({ [ACCOUNTS.a]: { husdt: 10 } });

  // Two candidate blocks in hour 3; the seed hash is odd, so it picks the second, which the snapshot is at.
  const picked = hourly(start, holdings);
  const n = picked[3].block.number;
  picked[3].selection = { firstBlock: n - 1, blocks: 2, seed: { number: n + 1, hash: hashOf(3) }, index: 1 };
  const ok = makeDataDir({ snapshots: picked });
  assert.doesNotThrow(() => close(ok.dataDir, ok.denylistPath));

  // The same snapshot claiming the second block while the seed hash is even, which picks the first.
  const wrong = hourly(start, holdings);
  wrong[3].selection = { firstBlock: n - 1, blocks: 2, seed: { number: n + 1, hash: hashOf(4) }, index: 1 };
  const w = makeDataDir({ snapshots: wrong });
  assert.throws(() => close(w.dataDir, w.denylistPath), /its block is not the one its hour's seed block picks/);

  // A snapshot that records no selection, such as one taken at the first block of its hour.
  const unrecorded = hourly(start, holdings);
  delete (unrecorded[3] as { selection?: unknown }).selection;
  const u = makeDataDir({ snapshots: unrecorded });
  assert.throws(() => close(u.dataDir, u.denylistPath), /its block is not the one its hour's seed block picks/);

  // The index the seed picks, but recorded for another block than the snapshot is at.
  const elsewhere = hourly(start, holdings);
  elsewhere[3].selection = { firstBlock: n - 1, blocks: 2, seed: { number: n + 1, hash: hashOf(4) }, index: 0 };
  const e = makeDataDir({ snapshots: elsewhere });
  assert.throws(() => close(e.dataDir, e.denylistPath), /its block is not the one its hour's seed block picks/);

  // A seed that is not the first block after the hour's blocks.
  const laterSeed = hourly(start, holdings);
  laterSeed[3].selection = { firstBlock: n - 1, blocks: 2, seed: { number: n + 5, hash: hashOf(3) }, index: 1 };
  const s = makeDataDir({ snapshots: laterSeed });
  assert.throws(() => close(s.dataDir, s.denylistPath), /its block is not the one its hour's seed block picks/);
});

// Four days of snapshots, and program files that differ in the HUSDT budget and the first epoch they pay.
function threeDays() {
  const dataDir = mkdtempSync(join(tmpdir(), "hydration-rewards-"));
  let denylistPath = "";
  for (const [k, epoch] of ["2026-11-12", "2026-11-13", "2026-11-14", "2026-11-15"].entries()) {
    const s = epochWindow(epoch, START_HOUR).start;
    ({ denylistPath } = makeDataDir({
      snapshots: hourly(s, () => ({ [ACCOUNTS.a]: { husdt: 10 } }), (k + 1) * 1_000),
      into: dataDir,
    }));
  }
  const programText = (husdt: number, from: string) =>
    `name: t\napplies_from_epoch: ${from}\nbudget_per_day:\n  HUSDC: 1\n  HUSDT: ${husdt}\n` +
    "epoch_start_hour_utc: 14\nearn_on_supply_of: [HUSDC, HUSDT]\nmax_hollar_debt_usd: 5\n";
  const denylist = loadDenylist(denylistPath);
  const toDisk = (
    epoch: string,
    husdt: number,
    extra: Partial<Parameters<typeof closeEpochToDisk>[0]> = {},
    from = "2026-11-12",
  ) =>
    closeEpochToDisk({
      dataDir,
      epoch,
      program: parseProgram(programText(husdt, from), config, { requireDecisions: true }),
      config,
      denylist,
      genesis: epoch === "2026-11-12",
      previousTreePath:
        epoch === "2026-11-12" ? null : join(dataDir, "trees", `${epoch.slice(0, 8)}${+epoch.slice(8) - 1}.json`),
      ...extra,
    });
  const stored = (epoch: string) => readFileSync(join(dataDir, "trees", `${epoch}.json`), "utf8");
  return { dataDir, denylistPath, toDisk, stored };
}

test("a hand close cannot leave a closed day out of the chain with --genesis or --allow-gap", () => {
  const { dataDir, toDisk } = threeDays();
  toDisk("2026-11-12", 1);
  toDisk("2026-11-13", 1);
  assert.throws(
    () => toDisk("2026-11-14", 1, { genesis: true, previousTreePath: null }),
    /2026-11-13 is already closed, so 2026-11-14 cannot start a new chain \(--genesis\)/,
  );
  assert.throws(
    () => toDisk("2026-11-14", 1, { previousTreePath: join(dataDir, "trees", "2026-11-12.json"), allowGap: true }),
    /2026-11-14 would build on 2026-11-12, but 2026-11-13 is closed after it, .*; --allow-gap is only for days that have no tree/,
  );
  assert.equal(existsSync(join(dataDir, "trees", "2026-11-14.json")), false);
  assert.doesNotThrow(() => toDisk("2026-11-14", 1));
});

test("the claims file is written first and the tree last, so a close cut off between them is simply done again", () => {
  const { dataDir, toDisk } = threeDays();
  // The claims file cannot be written: public/trees is a file where a folder should be.
  mkdirSync(join(dataDir, "public"), { recursive: true });
  writeFileSync(join(dataDir, "public", "trees"), "in the way");
  assert.throws(() => toDisk("2026-11-12", 1));
  assert.equal(existsSync(join(dataDir, "trees", "2026-11-12.json")), false, "the epoch does not look closed");
  assert.equal(existsSync(join(dataDir, "epochs", "2026-11-12.summary.json")), false, "nothing was left behind");

  rmSync(join(dataDir, "public", "trees"));
  const { tree } = toDisk("2026-11-12", 1);
  assert.ok(existsSync(join(dataDir, "public", "trees", `${tree.root}.json`)));
  assert.ok(existsSync(join(dataDir, "trees", "2026-11-12.json")));
});

test("a file that took over too late: the remedy the refusal gives works", () => {
  const { dataDir, toDisk } = threeDays();
  // The old file closed 2026-11-12 to 2026-11-14; the new one, which doubles HUSDT, applies from 2026-11-13.
  for (const epoch of ["2026-11-12", "2026-11-13", "2026-11-14"]) toDisk(epoch, 1);
  assert.throws(
    () => toDisk("2026-11-15", 2, {}, "2026-11-13"),
    /epoch 2026-11-14 was closed with another program file .* move the outputs of 2026-11-13 and of every later epoch \(data\/trees and data\/epochs\) aside and close them again in order with this file; otherwise set applies_from_epoch to 2026-11-15/,
  );

  // No root from 2026-11-13 on was posted: move those outputs aside and close them again in order.
  const aside = mkdtempSync(join(tmpdir(), "hydration-aside-"));
  for (const epoch of ["2026-11-13", "2026-11-14"]) {
    for (const [dir, file] of [
      ["trees", `${epoch}.json`],
      ["epochs", `${epoch}.csv`],
      ["epochs", `${epoch}.summary.json`],
    ]) {
      renameSync(join(dataDir, dir, file), join(aside, `${dir}-${file}`));
    }
  }
  for (const epoch of ["2026-11-13", "2026-11-14", "2026-11-15"]) toDisk(epoch, 2, {}, "2026-11-13");
  const tree15 = JSON.parse(readFileSync(join(dataDir, "trees", "2026-11-15.json"), "utf8")) as Tree;
  assert.equal(tree15.claims[ACCOUNTS.a].claimable, String(1_000_000 + 3 * 2_000_000));

  // The other remedy: the same settings, applying from the first epoch that was not closed yet.
  const other = threeDays();
  for (const epoch of ["2026-11-12", "2026-11-13", "2026-11-14"]) other.toDisk(epoch, 1);
  assert.doesNotThrow(() => other.toDisk("2026-11-15", 2, {}, "2026-11-15"));
});

test("--allow-partial waits until an hour after the epoch ends, when its last hour has been taken", () => {
  const { dataDir, denylistPath } = makeDataDir({
    snapshots: hourly(start, () => ({ [ACCOUNTS.a]: { husdt: 10 } })).filter((_, h) => h < 7),
  });
  const program = parseProgram(
    "name: t\napplies_from_epoch: 2026-11-12\nbudget_per_day:\n  HUSDC: 1\n  HUSDT: 1\n" +
      "epoch_start_hour_utc: 14\nearn_on_supply_of: [HUSDC, HUSDT]\nmax_hollar_debt_usd: 5\n",
    config,
    { requireDecisions: true },
  );
  const partial = (now: number) =>
    closeEpochToDisk({
      dataDir,
      epoch: EPOCH,
      program,
      config,
      denylist: loadDenylist(denylistPath),
      genesis: true,
      allowPartial: true,
      now,
    });
  const end = start + 86_400;
  assert.throws(
    () => partial(start + 8 * 3600),
    /epoch 2026-11-12 ends at 2026-11-13T14:00:00.000Z and its last hour is taken just after; --allow-partial is accepted from 2026-11-13T15:00:00.000Z/,
  );
  // Just after the end the runner may not have taken the last hour yet.
  assert.throws(() => partial(end + 60), /is accepted from 2026-11-13T15:00:00.000Z/);
  assert.throws(() => partial(end + 3599), /is accepted from/);
  assert.equal(partial(end + 3600).summary.snapshots.length, 7);
});

test("leftovers of a close that stopped before its tree are not replaced silently, and the refusal says why", () => {
  // An earlier close of 2026-11-12, with other budgets, wrote its CSV and summary and stopped before
  // its tree. (A tree removed by hand after its root was posted looks the same, so nothing is replaced
  // without --overwrite.)
  const { dataDir, denylistPath, toDisk } = threeDays();
  const earlier = close(dataDir, denylistPath, { budgets: new Map([...BUDGETS, ["HUSDT", 7n]]) });
  writeText(join(dataDir, "epochs", "2026-11-12.csv"), earlier.csv);
  writeText(join(dataDir, "epochs", "2026-11-12.summary.json"), toJson(earlier.summary));

  assert.throws(
    () => toDisk("2026-11-12", 1),
    /2026-11-12\.csv, .*2026-11-12\.summary\.json differ from this close, and 2026-11-12 has no tree: either an earlier close stopped before writing it \(it produced no root, so pass --overwrite\), or the tree was removed by hand \(put it back instead\)/,
  );
  assert.equal(readFileSync(join(dataDir, "epochs", "2026-11-12.csv"), "utf8"), earlier.csv);
  const { tree } = toDisk("2026-11-12", 1, { overwrite: true });
  assert.ok(existsSync(join(dataDir, "trees", "2026-11-12.json")));
  assert.ok(existsSync(join(dataDir, "public", "trees", `${tree.root}.json`)));
  // The same leftovers with the same result: done again without a word.
  rmSync(join(dataDir, "trees", "2026-11-12.json"));
  assert.doesNotThrow(() => toDisk("2026-11-12", 1));
});

test("program refusals name the remedy for the case they are in", () => {
  // The first epoch, with a file that applies from a later one.
  const first = threeDays();
  assert.throws(
    () => first.toDisk("2026-11-12", 1, {}, "2026-11-13"),
    /epoch 2026-11-12 would be the first epoch, but this program file applies from 2026-11-13: start with --first-epoch 2026-11-13, or set applies_from_epoch to 2026-11-12/,
  );

  // Closed again by hand on the newest epoch with a file that came too late: the date to move to is
  // the first epoch with no tree, not the one being closed.
  const late = threeDays();
  for (const epoch of ["2026-11-12", "2026-11-13", "2026-11-14"]) late.toDisk(epoch, 1);
  assert.throws(
    () => late.toDisk("2026-11-14", 2, { overwrite: true }, "2026-11-13"),
    /otherwise set applies_from_epoch to 2026-11-15, the first epoch not closed yet/,
  );

  // The older file loaded after a newer one took over: restart with the newer one.
  const older = threeDays();
  older.toDisk("2026-11-12", 1);
  older.toDisk("2026-11-13", 2, {}, "2026-11-13");
  assert.throws(
    () => older.toDisk("2026-11-14", 1),
    /epoch 2026-11-13 was closed with a newer program file \(0x[0-9a-f]{64}, which applies from 2026-11-13\) than this one \(applies from 2026-11-12\); restart the runner with that file/,
  );
});

test("the chain and program checks refuse when the file they need is missing", () => {
  const first = threeDays();
  first.toDisk("2026-11-12", 1);
  first.toDisk("2026-11-13", 1);
  rmSync(join(first.dataDir, "trees", "2026-11-12.json"));
  assert.throws(
    () => first.toDisk("2026-11-14", 1),
    /the tree for 2026-11-13 builds on 2026-11-12 with root 0x[0-9a-f]{64}, but there is no stored tree for 2026-11-12/,
  );

  const second = threeDays();
  second.toDisk("2026-11-12", 1);
  second.toDisk("2026-11-13", 1);
  rmSync(join(second.dataDir, "epochs", "2026-11-13.summary.json"));
  assert.throws(() => second.toDisk("2026-11-14", 1), /epoch 2026-11-13 was closed with no recorded program file/);
});

test("an epoch cannot be closed again with another result once a later epoch builds on it", () => {
  const { toDisk, stored } = threeDays();
  toDisk("2026-11-12", 1);
  toDisk("2026-11-13", 1);
  const before = stored("2026-11-12");

  // --overwrite only replaced the epoch's own files, so 2026-11-13 kept building on the old tree.
  assert.throws(
    () => toDisk("2026-11-12", 2, { overwrite: true }),
    /2026-11-13 is already closed on top of 2026-11-12 as it is stored; .* move the outputs of 2026-11-12 and of every later epoch aside/,
  );
  assert.equal(stored("2026-11-12"), before);
  // The same result again changes nothing, so it is still allowed.
  assert.doesNotThrow(() => toDisk("2026-11-12", 1));
});

test("an epoch cannot be closed after a later one was closed without it", () => {
  const { dataDir, toDisk } = threeDays();
  toDisk("2026-11-12", 1);
  // 2026-11-13 was skipped by hand with --allow-gap.
  toDisk("2026-11-14", 1, { previousTreePath: join(dataDir, "trees", "2026-11-12.json"), allowGap: true });
  assert.throws(() => toDisk("2026-11-13", 1), /2026-11-14 is already closed without 2026-11-13/);
});

test("a close builds only on the stored chain: the stored previous tree, which builds on the stored one before it", () => {
  const { dataDir, denylistPath, toDisk } = threeDays();
  const e12 = toDisk("2026-11-12", 1);
  toDisk("2026-11-13", 1);

  // A previous tree passed in from elsewhere that is not the stored one.
  const otherDir = mkdtempSync(join(tmpdir(), "hydration-rewards-"));
  const elsewhere = join(otherDir, "2026-11-13.json");
  const other13 = close(dataDir, denylistPath, {
    epoch: "2026-11-13",
    genesis: false,
    previousTreePath: e12.treePath,
    budgets: new Map([...BUDGETS, ["HUSDT", 7n]]),
  }).tree;
  writeFileSync(elsewhere, toJson(other13));
  assert.throws(() => toDisk("2026-11-14", 1, { previousTreePath: elsewhere }), /is not the one stored for 2026-11-13/);

  // 2026-11-12 replaced on disk after 2026-11-13 was built on it (by hand, or by an older version of
  // this tool): the next close finds the link broken instead of carrying the old tree forward.
  const replaced = close(dataDir, denylistPath, { budgets: new Map([...BUDGETS, ["HUSDT", 7n]]) }).tree;
  storeTree(dataDir, replaced);
  assert.throws(
    () => toDisk("2026-11-14", 1),
    /the tree for 2026-11-13 builds on 2026-11-12 with root 0x[0-9a-f]{64}, but the stored tree for 2026-11-12 has root .*: 2026-11-12 was closed again after 2026-11-13 was built on it/,
  );

  // A previous tree for an epoch the data directory holds no tree for.
  const fresh = makeDataDir({ snapshots: hourly(epochWindow("2026-11-13", START_HOUR).start, () => ({})) });
  assert.throws(
    () =>
      close(fresh.dataDir, fresh.denylistPath, { epoch: "2026-11-13", genesis: false, previousTreePath: e12.treePath }),
    /the previous tree is for 2026-11-12, but .* holds no tree for that epoch/,
  );
});
