import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { epochWindow } from "../src/close-epoch.ts";
import { loadProgram, parseProgram, toRawUnits } from "../src/program.ts";
import { previewProgram } from "../src/preview.ts";
import { makeDenylist } from "../src/lib/denylist.ts";
import { $, ACCOUNTS, hourly } from "./helpers.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const config = JSON.parse(readFileSync(join(root, "config", "mainnet.json"), "utf8"));
const { start } = epochWindow("2026-11-12", 14);

const SETTINGS = {
  name: "name: test",
  applies_from_epoch: "applies_from_epoch: 2026-11-12",
  budget_per_day: "budget_per_day:\n  HUSDC: 1\n  HUSDT: 1",
  epoch_start_hour_utc: "epoch_start_hour_utc: 14",
  earn_on_supply_of: "earn_on_supply_of: [HUSDC, HUSDT]",
  max_hollar_debt_usd: "max_hollar_debt_usd: 5",
};
// A complete program with some settings replaced (or removed, with null).
const program = (changes = {}) =>
  Object.values({ ...SETTINGS, ...changes })
    .filter((line) => line !== null)
    .join("\n");

// Checks how each shipped file behaves, never what it holds: a program pull request changes the values.
test("every shipped program file loads, and closes an epoch only once every decision is filled in", () => {
  const files = readdirSync(join(root, "programs")).filter((f) => f.endsWith(".yaml"));
  assert.ok(files.length > 0);
  for (const file of files) {
    const path = join(root, "programs", file);
    const p = loadProgram(path, config); // the preview reads it whatever is still blank
    const undecided =
      [...p.budgetPerDay.values()].some((budget) => budget === null) ||
      p.startHourUtc === null ||
      p.appliesFromEpoch === null;
    if (undecided) {
      assert.throws(() => loadProgram(path, config, { requireDecisions: true }), /is blank/, file);
    } else {
      assert.doesNotThrow(() => loadProgram(path, config, { requireDecisions: true }), file);
    }
  }
});

test("the first epoch a program file pays is a decision: a real date, and required to close an epoch", () => {
  assert.equal(parseProgram(program(), config, { requireDecisions: true }).appliesFromEpoch, "2026-11-12");
  for (const line of ["applies_from_epoch:", null]) {
    // Left blank or left out, it previews, and stops a close.
    assert.equal(parseProgram(program({ applies_from_epoch: line }), config).appliesFromEpoch, null);
    assert.throws(
      () => parseProgram(program({ applies_from_epoch: line }), config, { requireDecisions: true }),
      /applies_from_epoch is blank; write the first epoch this file pays/,
    );
  }
  for (const value of ["2026-11-31", "12 Nov 2026", "2026-11-1", "tomorrow"]) {
    assert.throws(
      () => parseProgram(program({ applies_from_epoch: `applies_from_epoch: ${value}` }), config),
      /applies_from_epoch must be a date like 2027-01-15/,
    );
  }
});

test("a program file loads from any folder", () => {
  // The skill previews a saved copy of the old program from a temporary folder.
  const path = join(mkdtempSync(join(tmpdir(), "hydration-program-")), "before.yaml");
  writeFileSync(path, program());
  assert.equal(loadProgram(path, config, { requireDecisions: true }).name, "test");
});

test("budgets and the HOLLAR allowance are read as exact decimals", () => {
  assert.equal(toRawUnits("275.616", 6, "x"), 275_616_000n);
  assert.equal(toRawUnits("0.000001", 6, "x"), 1n);
  assert.throws(() => toRawUnits("1.0000001", 6, "x"), /more than 6 decimal places/);
  assert.throws(() => toRawUnits("1e3", 6, "x"), /plain number/);
  const p = parseProgram(program({ budget_per_day: "budget_per_day:\n  HUSDC: 275.616\n  HUSDT: 1" }), config);
  assert.equal(p.budgetPerDay.get("HUSDC"), 275_616_000n);

  assert.equal(parseProgram(program({ max_hollar_debt_usd: "max_hollar_debt_usd: 0" }), config).maxHollarDebt, 0n);
  assert.equal(
    parseProgram(program({ max_hollar_debt_usd: "max_hollar_debt_usd: 2.50" }), config).maxHollarDebt,
    (5n * $(1)) / 2n,
  );
  assert.throws(
    () => parseProgram(program({ max_hollar_debt_usd: "max_hollar_debt_usd: 2.505" }), config),
    /more than 2 decimal places/,
  );
});

test("the HOLLAR allowance can never be left out or blank", () => {
  assert.throws(() => parseProgram(program({ max_hollar_debt_usd: null }), config), /"max_hollar_debt_usd" is missing/);
  assert.throws(
    () => parseProgram(program({ max_hollar_debt_usd: "max_hollar_debt_usd:" }), config),
    /max_hollar_debt_usd is blank/,
  );
  assert.throws(
    () => parseProgram(program({ max_hollar_debt_usd: "max_hollar_debt_usd: none" }), config),
    /not a plain number/,
  );
});

test("mistakes stop the run with a message a non-developer can act on", () => {
  const withLine = (line: string) => `${program()}\n${line}`;
  assert.throws(
    () => parseProgram(withLine("max_holar_debt_usd: 5"), config),
    /"max_holar_debt_usd" is not known\. Did you mean max_hollar_debt_usd\?/,
  );
  assert.throws(() => parseProgram(program({ name: null }), config), /"name" is missing/);
  assert.throws(
    () => parseProgram(program({ earn_on_supply_of: "earn_on_supply_of: [HUSDC, HUSDZ]" }), config),
    /"HUSDZ" is not known\. Did you mean HUSDC or HUSDT\?.*ask a developer/,
  );
  assert.throws(
    () => parseProgram(program({ budget_per_day: "budget_per_day:\n  HUSDC: 1\n  HUSDZ: 1" }), config),
    /budget_per_day asset "HUSDZ"/,
  );
  assert.throws(
    () => parseProgram(program({ budget_per_day: "budget_per_day:\n  HUSDC: 1" }), config),
    /no line for HUSDT/,
  );
  assert.throws(
    () => parseProgram(program({ epoch_start_hour_utc: "epoch_start_hour_utc: 24" }), config),
    /whole hour from 0 to 23/,
  );
  assert.throws(
    () => parseProgram(program({ earn_on_supply_of: "earn_on_supply_of: [HUSDT, HUSDT]" }), config),
    /lists HUSDT twice/,
  );
});

test("HEURC earns next to HUSDC and HUSDT, with a budget of its own", () => {
  const p = parseProgram(
    program({
      earn_on_supply_of: "earn_on_supply_of: [HUSDC, HUSDT, HEURC]",
      budget_per_day: "budget_per_day:\n  HUSDC: 1\n  HUSDT: 1\n  HEURC: 2.5",
    }),
    config,
    { requireDecisions: true },
  );
  assert.deepEqual(p.earn, ["HUSDC", "HUSDT", "HEURC"]);
  assert.equal(p.budgetPerDay.get("HEURC"), 2_500_000n);
  // Earning without a budget line of its own is refused.
  assert.throws(
    () => parseProgram(program({ earn_on_supply_of: "earn_on_supply_of: [HUSDC, HUSDT, HEURC]" }), config),
    /no line for HEURC/,
  );
});

test("settings from other strategies are refused, not ignored", () => {
  for (const line of [
    "rules:\n  - subtract_debt: [HOLLAR]",
    "exclude_accounts: config/denylist.json",
    "reward: PRIME",
  ]) {
    assert.throws(() => parseProgram(`${program()}\n${line}`, config), /is not known/);
  }
});

test("the preview reports eligible value and what the HOLLAR rule removed", () => {
  const snapshots = hourly(start, () => ({
    [ACCOUNTS.a]: { husdt: 100_000, hollar: 67_000 },
    [ACCOUNTS.b]: { husdc: 10_000 },
    [ACCOUNTS.treasury]: { husdt: 5_000 },
  }));
  const denylist = makeDenylist({ rules: { palletAccounts: true }, addresses: [] });
  const { text, perAccount } = previewProgram(parseProgram(program(), config), snapshots, {
    denylist,
    reward: config.reward,
    rewardPriceUsd: 1,
  });
  assert.match(text, /Supplied HUSDC \+ HUSDT\s+\$115,000/);
  assert.match(text, /excluded accounts \(1\)\s+-\$5,000/);
  assert.match(text, /HOLLAR debt above \$5\.00 \(1 accounts\)\s+-\$100,000/);
  assert.match(text, /Eligible\s+\$10,000/);
  assert.match(text, /Accounts earning: 1/);
  assert.equal(perAccount.find((r) => r.account === ACCOUNTS.a)?.eligibleUsd, 0);
  assert.equal(perAccount.find((r) => r.account === ACCOUNTS.b)?.rewardPerDay, 1);

  const blank = parseProgram(program({ budget_per_day: "budget_per_day:\n  HUSDC:\n  HUSDT:" }), config);
  assert.match(
    previewProgram(blank, snapshots, { denylist, reward: config.reward }).text,
    /budget_per_day is blank for HUSDC and HUSDT, so no amounts are shown/,
  );
  // One budget filled in is still not enough to show amounts, and the message names the one left.
  const half = parseProgram(program({ budget_per_day: "budget_per_day:\n  HUSDC: 1\n  HUSDT:" }), config);
  assert.match(
    previewProgram(half, snapshots, { denylist, reward: config.reward }).text,
    /budget_per_day is blank for HUSDT, so no amounts are shown/,
  );
});
