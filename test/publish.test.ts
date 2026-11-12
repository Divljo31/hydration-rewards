// The files the app reads: the claims published under each root, and the per-account status.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { StandardMerkleTree } from "@openzeppelin/merkle-tree";
import { closeEpochToDisk, epochWindow } from "../src/close-epoch.ts";
import { loadDenylist, makeDenylist } from "../src/lib/denylist.ts";
import { parseProgram } from "../src/program.ts";
import { claimsPath, latestFile, latestPath, publishLatest } from "../src/publish.ts";
import type { ClaimsFile, Config } from "../src/types.ts";
import { ACCOUNTS, hourly, makeDataDir, makeSnapshot } from "./helpers.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const config = JSON.parse(readFileSync(join(root, "config", "mainnet.json"), "utf8")) as Config;

const programText = (budgets: string) => `name: publish test
applies_from_epoch: 2026-11-12
budget_per_day:
${budgets}
epoch_start_hour_utc: 14
earn_on_supply_of: [HUSDC, HUSDT]
max_hollar_debt_usd: 5
`;
const program = parseProgram(programText("  HUSDC: 1\n  HUSDT: 1"), config, { requireDecisions: true });
const denylist = makeDenylist({ rules: { palletAccounts: true }, addresses: [] });
const start = (epoch: string) => epochWindow(epoch, 14).start;

test("the status file says who is earning, who is not and why", () => {
  const snapshot = makeSnapshot({
    number: 77,
    timestamp: 1_800_003_602,
    target: 1_800_003_600,
    accounts: {
      [ACCOUNTS.c]: { husdt: 7, hollar: 3 },
      [ACCOUNTS.a]: { husdt: 100 },
      [ACCOUNTS.treasury]: { husdt: 5_000 },
      [ACCOUNTS.b]: { husdc: 300, hollar: 40, hollarBil: 10.5 },
    },
  });
  const latest = latestFile({
    snapshot,
    program,
    reward: config.reward,
    denylist,
    latestTree: { epoch: "2027-01-15", root: `0x${"ab".repeat(32)}` },
  });

  assert.equal(latest.format, "hydration-rewards-latest/1");
  assert.deepEqual(latest.asOf, { hour: 1_800_003_600, block: 77, blockTime: 1_800_003_602 });
  assert.deepEqual(latest.reward, { symbol: "PRIME", address: config.reward.address, decimals: 6 });
  assert.deepEqual(latest.program, { name: "publish test", sha256: program.sha256, maxHollarDebtUsd: "5.00" });
  assert.deepEqual(latest.accounts, {
    [ACCOUNTS.a]: { earning: true, hollarDebtUsd: "0.00" },
    // debt on two markets is added up
    [ACCOUNTS.b]: { earning: false, reason: "hollar_debt", hollarDebtUsd: "50.50" },
    // within the allowance
    [ACCOUNTS.c]: { earning: true, hollarDebtUsd: "3.00" },
    [ACCOUNTS.treasury]: { earning: false, reason: "excluded" },
  });
  assert.deepEqual(Object.keys(latest.accounts), [ACCOUNTS.a, ACCOUNTS.b, ACCOUNTS.c, ACCOUNTS.treasury]);
  // b's HUSDC earns nothing, so the HUSDC budget has no eligible value to be shared over
  assert.deepEqual(latest.assets, {
    HUSDC: { budgetPerDay: "1000000", eligibleUsd: "0.00" },
    HUSDT: { budgetPerDay: "1000000", eligibleUsd: "107.00" },
  });
  assert.deepEqual(latest.latestTree, { epoch: "2027-01-15", root: `0x${"ab".repeat(32)}` });

  const undecided = parseProgram(programText("  HUSDC:\n  HUSDT:"), config);
  const blank = latestFile({ snapshot, program: undecided, reward: config.reward, denylist, latestTree: null });
  assert.equal(blank.assets.HUSDT.budgetPerDay, null);
  assert.equal(blank.latestTree, null);
});

test("the status file is only rewritten when it changes", () => {
  const { dataDir } = makeDataDir({ snapshots: [] });
  const snapshot = makeSnapshot({ number: 1, timestamp: 3_600, accounts: { [ACCOUNTS.a]: { husdt: 100 } } });
  const latest = latestFile({ snapshot, program, reward: config.reward, denylist, latestTree: null });
  assert.equal(publishLatest(dataDir, latest), true);
  const written = statSync(latestPath(dataDir)).mtimeMs;
  assert.equal(publishLatest(dataDir, latest), false);
  assert.equal(statSync(latestPath(dataDir)).mtimeMs, written);
  assert.equal(publishLatest(dataDir, { ...latest, latestTree: { epoch: "2027-01-15", root: "0x01" } }), true);
});

// One closed epoch on disk, the way the runner and the close command leave it.
function closeOne(epoch: string, holdings: Parameters<typeof hourly>[1], into: string | null = null, previous = false) {
  const { dataDir, denylistPath } = makeDataDir({
    snapshots: hourly(start(epoch), holdings, Number(epoch.slice(-2)) * 1_000),
    into,
  });
  const result = closeEpochToDisk({
    dataDir,
    epoch,
    program,
    config,
    denylist: loadDenylist(denylistPath),
    genesis: !previous,
    previousTreePath: previous
      ? join(dataDir, "trees", `${epoch.slice(0, 8)}${Number(epoch.slice(-2)) - 1}.json`)
      : null,
  });
  return { dataDir, denylistPath, ...result };
}
const published = (dataDir: string, treeRoot: string): ClaimsFile =>
  JSON.parse(readFileSync(claimsPath(dataDir, treeRoot), "utf8"));

test("an app can claim from the published file alone, found by the root the distributor holds", () => {
  const { dataDir, tree } = closeOne("2026-11-12", () => ({
    [ACCOUNTS.a]: { husdt: 100 },
    [ACCOUNTS.b]: { husdc: 50, husdt: 25 },
    [ACCOUNTS.c]: { husdt: 900, hollar: 20 },
  }));
  const onChainRoot = tree.root; // what URD.root() returns once this root is accepted
  const file = published(dataDir, onChainRoot);

  assert.deepEqual(Object.keys(file), ["format", "reward", "root", "leafEncoding", "claims"]);
  assert.equal(file.format, "hydration-rewards-claims/1");
  assert.equal(file.root, onChainRoot);
  assert.equal(file.reward, config.reward.address);
  assert.deepEqual(Object.keys(file.claims).sort(), [ACCOUNTS.a, ACCOUNTS.b]); // c borrowed HOLLAR
  for (const [account, { claimable, proof }] of Object.entries(file.claims)) {
    assert.match(claimable, /^[1-9]\d*$/);
    // claim(account, reward, claimable, proof): the leaf the distributor rebuilds must verify
    assert.ok(StandardMerkleTree.verify(onChainRoot, file.leafEncoding, [account, file.reward, claimable], proof));
  }
  assert.equal(existsSync(join(dataDir, "public", "latest.json")), false); // the runner writes that one
});

test("a day that pays nobody ends on the same root and does not clash with the published tree", () => {
  const first = closeOne("2026-11-12", () => ({ [ACCOUNTS.a]: { husdt: 100 } }));
  const before = readFileSync(claimsPath(first.dataDir, first.tree.root), "utf8");

  // The next day the only holder has HOLLAR debt, so nobody earns and no amount changes.
  const second = closeOne("2026-11-13", () => ({ [ACCOUNTS.b]: { husdt: 100, hollar: 60 } }), first.dataDir, true);
  assert.equal(second.tree.root, first.tree.root);
  assert.equal(second.summary.paidAccounts, 0);
  assert.notEqual(
    readFileSync(join(first.dataDir, "trees", "2026-11-13.json"), "utf8"),
    readFileSync(join(first.dataDir, "trees", "2026-11-12.json"), "utf8"),
  );
  assert.equal(readFileSync(claimsPath(first.dataDir, second.tree.root), "utf8"), before);
  assert.deepEqual(readdirSync(join(first.dataDir, "public", "trees")), [`${first.tree.root}.json`]);
});

test("a refused close publishes nothing, and a replaced epoch keeps the old root's file", () => {
  const { dataDir, denylistPath } = makeDataDir({
    snapshots: hourly(start("2026-11-12"), () => ({ [ACCOUNTS.a]: { husdt: 100 } })),
  });
  const close = (changes: object = {}) =>
    closeEpochToDisk({
      dataDir,
      epoch: "2026-11-12",
      program,
      config,
      denylist: loadDenylist(denylistPath),
      genesis: true,
      ...changes,
    });

  assert.throws(() => close({ genesis: false }), /previous tree is required/);
  assert.equal(existsSync(join(dataDir, "public")), false);

  const first = close();
  // The same epoch closed again with another budget: refused, and nothing new is published.
  const richer = parseProgram(programText("  HUSDC: 1\n  HUSDT: 2"), config, { requireDecisions: true });
  assert.throws(() => close({ program: richer }), /already closed with a different result/);
  assert.deepEqual(readdirSync(join(dataDir, "public", "trees")), [`${first.tree.root}.json`]);

  // Overwriting publishes the new root and leaves the old root's file for anyone still claiming from it.
  const second = close({ program: richer, overwrite: true });
  assert.notEqual(second.tree.root, first.tree.root);
  assert.deepEqual(
    readdirSync(join(dataDir, "public", "trees")).sort(),
    [`${first.tree.root}.json`, `${second.tree.root}.json`].sort(),
  );
});
