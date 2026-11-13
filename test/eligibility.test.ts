import { test } from "node:test";
import assert from "node:assert/strict";
import { snapshotEligibility } from "../src/eligibility.ts";
import { makeDenylist } from "../src/lib/denylist.ts";
import { $, ACCOUNTS, makeSnapshot } from "./helpers.ts";
import type { Holding } from "./helpers.ts";

const denylist = makeDenylist({
  rules: { palletAccounts: true },
  addresses: [{ address: ACCOUNTS.listed, label: "listed" }],
});
const FIVE = $(5);

function eligibleFor(
  h: Holding,
  { maxHollarDebt = FIVE, prices }: { maxHollarDebt?: bigint; prices?: Record<string, bigint> } = {},
) {
  const s = makeSnapshot({ number: 1, timestamp: 1, accounts: { [ACCOUNTS.a]: h }, prices });
  const per = snapshotEligibility(s, { denylist, maxHollarDebt }).eligible.get(ACCOUNTS.a);
  return { HUSDC: per?.get("HUSDC"), HUSDT: per?.get("HUSDT") };
}

test("an account without HOLLAR debt earns on everything it supplies", () => {
  assert.deepEqual(eligibleFor({ husdc: 100_000, husdt: 50_000 }), { HUSDC: $(100_000), HUSDT: $(50_000) });
});

test("an account with HOLLAR debt earns nothing, however small the debt is next to its supply", () => {
  assert.deepEqual(eligibleFor({ husdc: 100_000, husdt: 50_000, hollar: 1_352 }), { HUSDC: 0n, HUSDT: 0n });
  // Other collateral is not an input: the debt counts whatever backs it.
  assert.deepEqual(eligibleFor({ husdt: 100_000, hollar: 150_000 }), { HUSDC: 0n, HUSDT: 0n });
});

test("debt up to the allowance is ignored; one cent more disqualifies", () => {
  assert.equal(eligibleFor({ husdt: 100, hollar: 5 }).HUSDT, $(100));
  assert.equal(eligibleFor({ husdt: 100, hollar: 5.01 }).HUSDT, 0n);
  // With no allowance any debt disqualifies, and no debt still earns.
  assert.equal(eligibleFor({ husdt: 100, hollar: 0.01 }, { maxHollarDebt: 0n }).HUSDT, 0n);
  assert.equal(eligibleFor({ husdt: 100 }, { maxHollarDebt: 0n }).HUSDT, $(100));
});

test("HOLLAR debt is added up over main, GIGAHDX and BIL", () => {
  assert.equal(eligibleFor({ husdt: 100, hollarGigahdx: 4 }).HUSDT, $(100));
  assert.equal(eligibleFor({ husdt: 100, hollarBil: 4 }).HUSDT, $(100));
  assert.equal(eligibleFor({ husdt: 100, hollar: 2, hollarGigahdx: 2, hollarBil: 2 }).HUSDT, 0n);
});

test("values use the market's oracle prices", () => {
  // 1,000 HUSDC at the oracle's 1.02414767 is worth $1,024.14767.
  const e = eligibleFor({ husdc: 1_000 }, { prices: { HUSDC: 102_414_767n } }).HUSDC;
  assert.equal(e, 1_000n * 10n ** 18n * 102_414_767n);
  // 4.60 HOLLAR priced at 1.10 is $5.06 of debt, above the allowance.
  assert.equal(eligibleFor({ husdt: 100, hollar: 4.6 }).HUSDT, $(100));
  assert.equal(eligibleFor({ husdt: 100, hollar: 4.6 }, { prices: { HOLLAR: 110_000_000n } }).HUSDT, 0n);
});

test("what the rule removed is reported", () => {
  const s = makeSnapshot({
    number: 1,
    timestamp: 1,
    accounts: {
      [ACCOUNTS.a]: { husdt: 100 },
      [ACCOUNTS.b]: { husdc: 300, hollar: 50 },
      [ACCOUNTS.c]: { husdt: 7, hollar: 9 },
    },
  });
  const { borrowers, gross } = snapshotEligibility(s, { denylist, maxHollarDebt: FIVE });
  assert.deepEqual([...borrowers.accounts].sort(), [ACCOUNTS.b, ACCOUNTS.c]);
  assert.equal(borrowers.value, $(307));
  assert.equal(gross, $(407));
});

test("denylisted accounts earn nothing and are reported", () => {
  const s = makeSnapshot({
    number: 1,
    timestamp: 1,
    accounts: { [ACCOUNTS.a]: { husdt: 10 }, [ACCOUNTS.treasury]: { husdt: 400_000 }, [ACCOUNTS.listed]: { husdc: 5 } },
  });
  const { eligible, excluded } = snapshotEligibility(s, { denylist, maxHollarDebt: FIVE });
  assert.deepEqual([...eligible.keys()], [ACCOUNTS.a]);
  assert.equal(excluded.get(ACCOUNTS.treasury)?.reason, "pallet account py/trsry");
  assert.equal(excluded.get(ACCOUNTS.listed)?.reason, "listed");
});

test("the HOLLAR allowance has no default: leaving it out stops the calculation", () => {
  const s = makeSnapshot({ number: 1, timestamp: 1, accounts: { [ACCOUNTS.a]: { husdt: 100, hollar: 50 } } });
  // @ts-expect-error the allowance is left out on purpose
  assert.throws(() => snapshotEligibility(s, { denylist }), /allowed HOLLAR debt is required/);
  // @ts-expect-error a number, not a bigint in value units
  assert.throws(() => snapshotEligibility(s, { denylist, maxHollarDebt: 5 }), /allowed HOLLAR debt is required/);
  // @ts-expect-error null is not an allowance
  assert.throws(() => snapshotEligibility(s, { denylist, maxHollarDebt: null }), /allowed HOLLAR debt is required/);
});

test("missing data stops the calculation instead of counting as zero", () => {
  const s = makeSnapshot({ number: 1, timestamp: 1, accounts: { [ACCOUNTS.a]: { husdt: 100, hollar: 50 } } });
  delete s.accounts[ACCOUNTS.a].debt.HOLLAR.gigahdx;
  assert.throws(() => snapshotEligibility(s, { denylist, maxHollarDebt: FIVE }), /debt\.HOLLAR\.gigahdx/);

  const noHollar = makeSnapshot({ number: 1, timestamp: 1, accounts: { [ACCOUNTS.a]: { husdt: 100 } } });
  delete noHollar.debtAssets.HOLLAR;
  assert.throws(() => snapshotEligibility(noHollar, { denylist, maxHollarDebt: FIVE }), /did not record HOLLAR debt/);
  // A snapshot taken before an asset was added to the config has no supply of it to count.
  assert.throws(
    () => snapshotEligibility(s, { denylist, maxHollarDebt: FIVE, earn: ["HUSDT", "HEURC"] }),
    /did not record supply of HEURC/,
  );
  // @ts-expect-error the denylist is left out on purpose
  assert.throws(() => snapshotEligibility(noHollar, { maxHollarDebt: FIVE }), /denylist is required/);
});

test("an earning asset listed twice is refused instead of counted twice", () => {
  const s = makeSnapshot({ number: 1, timestamp: 1, accounts: { [ACCOUNTS.a]: { husdt: 100 } } });
  assert.throws(
    () => snapshotEligibility(s, { denylist, maxHollarDebt: FIVE, earn: ["HUSDT", "HUSDT"] }),
    /listed twice/,
  );
  assert.equal(
    snapshotEligibility(s, { denylist, maxHollarDebt: FIVE, earn: ["HUSDT"] })
      .eligible.get(ACCOUNTS.a)
      ?.get("HUSDT"),
    $(100),
  );
});
