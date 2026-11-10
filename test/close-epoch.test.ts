import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeEpoch, epochWindow, writeOutputs } from "../src/close-epoch.ts";
import type { CloseEpochInput } from "../src/close-epoch.ts";
import type { Tree } from "../src/types.ts";
import { allocate } from "../src/allocate.ts";
import { toJson } from "../src/lib/io.ts";
import { $, ACCOUNTS, hourly, makeDataDir, makeSnapshot, parseCsv } from "./helpers.ts";

const PRIME = "0x000000000000000000000000000000010000002b";
const EPOCH = "2026-11-12";
const START_HOUR = 14;
const { start } = epochWindow(EPOCH, START_HOUR);
const BUDGETS = new Map([
  ["HUSDC", 1_000_000n],
  ["HUSDT", 1_000_000n],
]);

function close(dataDir: string, denylistPath: string, overrides: Partial<CloseEpochInput> = {}) {
  return closeEpoch({
    dataDir,
    epoch: EPOCH,
    startHourUtc: START_HOUR,
    budgets: BUDGETS,
    maxHollarDebt: $(5),
    reward: PRIME,
    denylistPath,
    genesis: true,
    ...overrides,
  });
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
  const total = [...parseCsv(csv).values()].reduce((x, y) => x + y, 0n);
  const dust = 275_616_001n + 275_615_999n - total;
  assert.equal(String(total), summary.distributed);
  assert.equal(String(dust), summary.dust);
  assert.ok(dust >= 0n && dust < BigInt(summary.paidAccounts), `dust ${dust} vs ${summary.paidAccounts} accounts`);
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
  const treePath = (epoch: string, tree: Tree) => {
    const path = join(dataDir, `tree-${epoch}.json`);
    writeFileSync(path, toJson(tree)); // closeEpoch reads the previous tree from disk, as the CLI does
    return path;
  };

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
  const prev = join(first.dataDir, "tree-2026-11-12.json");
  writeFileSync(prev, toJson(e12.tree));

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
