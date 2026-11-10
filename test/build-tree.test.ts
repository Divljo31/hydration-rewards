import { test } from "node:test";
import assert from "node:assert/strict";
import { StandardMerkleTree } from "@openzeppelin/merkle-tree";
import { buildTree, LEAF_ENCODING } from "../src/build-tree.ts";
import { isPalletAccount, normalizeAddress, palletIdOf } from "../src/lib/accounts.ts";
import { formatEpochCsv } from "../src/close-epoch.ts";
import { toJson } from "../src/lib/io.ts";
import { ACCOUNTS, EPOCH_2, makeFixtures, PRIME, windowOf } from "../tools/make-fixtures.ts";

// buildTree with the daily window the fixtures use, unless the test gives its own.
type BuildOptions = Parameters<typeof buildTree>[0];
const build = (options: Omit<BuildOptions, "window"> & Partial<Pick<BuildOptions, "window">>) =>
  buildTree({ window: windowOf(options.epoch), ...options });

test("accounts are 20-byte addresses; 32-byte account ids are refused, not truncated", () => {
  assert.equal(normalizeAddress("0x00000000000000000000000000000000000A11CE"), ACCOUNTS.alice);
  // A Substrate account id and the 32-byte form of an EVM account: neither may be cut down to 20 bytes.
  assert.throws(() => normalizeAddress(`0x${"c0".repeat(20)}${"5b".repeat(12)}`), /20-byte/);
  assert.throws(() => normalizeAddress(`0x45544800${"d0".repeat(20)}${"00".repeat(8)}`), /20-byte/);
  assert.throws(() => normalizeAddress("0x1234"), /20-byte/);
  assert.throws(() => normalizeAddress("16fM2nc4mxA65FLsCqxx"), /20-byte/);
  assert.throws(
    () =>
      build({
        epoch: "2026-11-11",
        reward: PRIME,
        epochAmounts: new Map([[`0x${"c0".repeat(32)}`, 1n]]),
        genesis: true,
      }),
    /20-byte/,
  );
});

test("pallet accounts are recognised by their modl prefix", () => {
  const treasury = "0x6d6f646c70792f74727372790000000000000000";
  assert.equal(isPalletAccount(treasury), true);
  assert.equal(palletIdOf(treasury), "py/trsry");
  assert.equal(isPalletAccount(ACCOUNTS.alice), false);
});

test("the epoch CSV is sorted by address and leaves out zero amounts", () => {
  // bob's address has more leading zeros, so it sorts first.
  const csv = formatEpochCsv(
    new Map([
      [ACCOUNTS.alice, 1n],
      [ACCOUNTS.bob, 2n],
      [ACCOUNTS.carol, 0n],
    ]),
  );
  assert.equal(csv, `account,amount\n${ACCOUNTS.bob},2\n${ACCOUNTS.alice},1\n`);
});

test("the first epoch needs an explicit genesis flag", () => {
  assert.throws(
    () => build({ epoch: "2026-11-11", reward: PRIME, epochAmounts: new Map([[ACCOUNTS.alice, 1n]]) }),
    /previous tree is required/,
  );
});

test("amounts are cumulative and absent accounts are carried over", () => {
  const { tree1, tree2 } = makeFixtures();
  assert.equal(tree1.claims[ACCOUNTS.alice].claimable, "1000000000");
  assert.equal(tree2.claims[ACCOUNTS.alice].claimable, "1500000000");
  assert.equal(tree2.claims[ACCOUNTS.bob].claimable, "250500000");
  assert.equal(tree2.claims[ACCOUNTS.carol].claimable, "3141592");
  assert.equal(tree2.claims[ACCOUNTS.dave].claimable, "42000000");
  assert.equal(tree2.totals.cumulative, String(1500000000 + 250500000 + 3141592 + 42000000));
  assert.equal(tree2.previousRoot, tree1.root);
  assert.equal(tree2.previousEpoch, "2026-11-11");
});

test("every proof verifies against the URD leaf encoding", () => {
  const { tree2 } = makeFixtures();
  for (const [account, { claimable, proof }] of Object.entries(tree2.claims)) {
    assert.ok(StandardMerkleTree.verify(tree2.root, LEAF_ENCODING, [account, PRIME, claimable], proof));
  }
});

test("the same inputs give byte-identical output", () => {
  assert.equal(toJson(makeFixtures().tree2), toJson(makeFixtures().tree2));
});

test("a tampered previous tree is refused", () => {
  const { tree1 } = makeFixtures();
  const tampered = structuredClone(tree1);
  tampered.claims[ACCOUNTS.bob].claimable = "999999999999";
  assert.throws(
    () => build({ epoch: "2026-11-12", reward: PRIME, epochAmounts: EPOCH_2, previous: tampered }),
    /inconsistent/,
  );
});

test("a previous tree for another reward token or a later epoch is refused", () => {
  const { tree1 } = makeFixtures();
  const otherReward = "0x0000000000000000000000000000000100000000";
  assert.throws(
    () => build({ epoch: "2026-11-12", reward: otherReward, epochAmounts: EPOCH_2, previous: tree1 }),
    /previous tree pays/,
  );
  assert.throws(
    () => build({ epoch: "2026-11-10", reward: PRIME, epochAmounts: EPOCH_2, previous: tree1 }),
    /not before/,
  );
});

test("a previous tree that is not the day before is refused, because it drops the days in between", () => {
  const { tree1, tree2 } = makeFixtures(); // 2026-11-11 and 2026-11-12
  const epoch3 = new Map([[ACCOUNTS.alice, 1n]]);

  // Building 11-13 on 11-11 would lose everything dave earned on 11-12.
  assert.throws(
    () => build({ epoch: "2026-11-13", reward: PRIME, epochAmounts: epoch3, previous: tree1 }),
    /epoch before 2026-11-13 is 2026-11-12/,
  );
  const onTheDayBefore = build({ epoch: "2026-11-13", reward: PRIME, epochAmounts: epoch3, previous: tree2 });
  assert.equal(onTheDayBefore.claims[ACCOUNTS.dave].claimable, "42000000");

  // The override exists for a day that can never be closed, and the gap stays visible.
  const gap = build({ epoch: "2026-11-14", reward: PRIME, epochAmounts: epoch3, previous: tree2, allowGap: true });
  assert.equal(gap.previousEpoch, "2026-11-12");
  // Month boundaries count as adjacent days.
  const endOfMonth = build({ epoch: "2026-11-30", reward: PRIME, epochAmounts: epoch3, genesis: true });
  assert.doesNotThrow(() => build({ epoch: "2026-12-01", reward: PRIME, epochAmounts: epoch3, previous: endOfMonth }));
});

test("an epoch must be a real date, so one window cannot have two names", () => {
  const amounts = new Map([[ACCOUNTS.alice, 1n]]);
  for (const epoch of ["2026-11-31", "2026-02-30", "2026-13-01", "12 Nov 2026", "2026-11-1"]) {
    assert.throws(
      () =>
        buildTree({ epoch, window: { start: 0, end: 86_400 }, reward: PRIME, epochAmounts: amounts, genesis: true }),
      /must be a date like/,
    );
  }
  assert.throws(
    // @ts-expect-error the window is left out on purpose
    () => buildTree({ epoch: "2026-11-11", reward: PRIME, epochAmounts: amounts, genesis: true }),
    /window is required/,
  );
});

test("an epoch must start where the previous one ended", () => {
  const { tree1 } = makeFixtures(); // 2026-11-11, 14:00 to 14:00
  assert.deepEqual(tree1.window, windowOf("2026-11-11"));
  const amounts = new Map([[ACCOUNTS.alice, 1n]]);
  const shifted = (hours: number) => {
    const w = windowOf("2026-11-12");
    return { start: w.start + hours * 3600, end: w.end + hours * 3600 };
  };
  // The start hour moved from 14 to 10: four hours would be counted in both epochs.
  assert.throws(
    () => build({ epoch: "2026-11-12", window: shifted(-4), reward: PRIME, epochAmounts: amounts, previous: tree1 }),
    /without a gap or an overlap/,
  );
  // From 14 to 18: four hours would never be counted.
  assert.throws(
    () => build({ epoch: "2026-11-12", window: shifted(4), reward: PRIME, epochAmounts: amounts, previous: tree1 }),
    /without a gap or an overlap/,
  );
  assert.doesNotThrow(() =>
    build({
      epoch: "2026-11-12",
      window: shifted(4),
      reward: PRIME,
      epochAmounts: amounts,
      previous: tree1,
      allowGap: true,
    }),
  );
});
