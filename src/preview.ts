#!/usr/bin/env node
// Shows what a program file would do, using snapshots already taken. Writes nothing except an
// optional CSV, so it is safe to run while editing a program.
//
// Usage:
//   node src/preview.ts --program programs/my-program.yaml
//     [--epoch 2026-11-12 | --snapshot data/snapshots/1794304800.json]
//     [--csv out.csv] [--reward-price-usd 1.07]
// Without --epoch or --snapshot it uses the most recent day of snapshots under data/snapshots.
// --epoch needs the program's epoch_start_hour_utc to be filled in.

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { messageOf, readJson, writeText } from "./lib/io.ts";
import { usdExact, usdNumber, usdRounded } from "./lib/format.ts";
import { allocate } from "./allocate.ts";
import { epochWindow, loadEpochSnapshots } from "./close-epoch.ts";
import { epochEligibility, SNAPSHOT_FORMAT } from "./eligibility.ts";
import { loadDenylist } from "./lib/denylist.ts";
import { loadProgram } from "./program.ts";
import type { Config, Denylist, Program, RewardConfig, Snapshot } from "./types.ts";

const pct = (part: number, whole: number): string => (whole > 0 ? `${((100 * part) / whole).toFixed(1)}%` : "-");

// A snapshot file this version can read, or an error that names the file and what to do about it.
function readSnapshot(path: string): Snapshot {
  const s = readJson<Snapshot>(path);
  if (s?.format !== SNAPSHOT_FORMAT) {
    throw new Error(
      `${path} is not a ${SNAPSHOT_FORMAT} snapshot (it says ${JSON.stringify(s?.format)}); ` +
        "snapshots taken by an older version have to be taken again with src/snapshot.ts",
    );
  }
  return s;
}

function loadSnapshots(
  a: { snapshot?: string; epoch?: string; data: string },
  program: Program,
  perEpoch: number,
): Snapshot[] {
  if (a.snapshot) return [readSnapshot(a.snapshot)];
  const dir = join(a.data, "snapshots");
  if (!existsSync(dir)) {
    throw new Error(`no snapshots under ${dir}; this machine has no snapshot data yet (a developer can provide it)`);
  }
  if (a.epoch) {
    if (program.startHourUtc === null)
      throw new Error(
        "--epoch needs epoch_start_hour_utc to be filled in; leave --epoch out to use the latest snapshots",
      );
    const window = epochWindow(a.epoch, program.startHourUtc);
    return loadEpochSnapshots({ dir, epoch: a.epoch, window, expected: perEpoch, allowPartial: true }).map(
      (l) => l.snapshot,
    );
  }
  const files = readdirSync(dir)
    .filter((f) => /^\d+\.json$/.test(f))
    .sort((x, y) => parseInt(x, 10) - parseInt(y, 10))
    .slice(-perEpoch);
  if (files.length === 0) throw new Error(`no snapshots in ${dir}; take one with src/snapshot.ts`);
  return files.map((f) => readSnapshot(join(dir, f)));
}

export interface PreviewRow {
  account: string;
  eligibleUsd: number;
  // null while the program's budgets are blank
  rewardPerDay: number | null;
}

export function previewProgram(
  program: Program,
  snapshots: Snapshot[],
  {
    denylist,
    reward,
    rewardPriceUsd = null,
  }: { denylist: Denylist; reward: RewardConfig; rewardPriceUsd?: number | null },
): { text: string; perAccount: PreviewRow[] } {
  const n = BigInt(snapshots.length);
  const { eligible, totals, excluded, borrowers, gross } = epochEligibility(snapshots, {
    maxHollarDebt: program.maxHollarDebt,
    earn: program.earn,
    denylist,
  });

  const lines: string[] = [];
  const row = (label: string, value: string) => lines.push(label.padEnd(52) + value.padStart(14));
  const blocks = snapshots.map((s) => s.block.number);
  lines.push(`Program   ${program.name}`);
  lines.push(
    `Snapshots ${snapshots.length} (blocks ${Math.min(...blocks)} to ${Math.max(...blocks)}); values are averages over them`,
  );
  lines.push("");

  const excludedValue = [...excluded.values()].reduce((s, e) => s + e.value, 0n);
  const eligibleTotal = [...totals.values()].reduce((s, v) => s + v, 0n);
  const supplied = gross + excludedValue;
  row(`Supplied ${program.earn.join(" + ")}`, usdRounded(supplied / n));
  row(`  excluded accounts (${excluded.size})`, `-${usdRounded(excludedValue / n)}`);
  row(
    `  HOLLAR debt above $${usdExact(program.maxHollarDebt)} (${borrowers.accounts.size} accounts)`,
    `-${usdRounded(borrowers.value / n)}`,
  );
  lines.push(
    `Eligible`.padEnd(52) +
      usdRounded(eligibleTotal / n).padStart(14) +
      `   ${pct(usdNumber(eligibleTotal), usdNumber(supplied))} of supplied`,
  );
  for (const [asset, total] of totals) row(`  ${asset}`, usdRounded(total / n));
  lines.push(`Accounts earning: ${[...eligible.values()].filter((m) => [...m.values()].some((v) => v > 0n)).length}`);

  // Amounts are only shown once every budget is filled in.
  const budgets = new Map<string, bigint>();
  for (const [asset, budget] of program.budgetPerDay) if (budget !== null) budgets.set(asset, budget);
  const amounts = budgets.size === program.budgetPerDay.size ? allocate({ eligible, totals, budgets }).amounts : null;
  const unit = 10 ** reward.decimals;
  const perAccount: PreviewRow[] = [...eligible.entries()].map(([account, perAsset]) => ({
    account,
    eligibleUsd: usdNumber([...perAsset.values()].reduce((s, v) => s + v, 0n) / n),
    rewardPerDay: amounts ? Number(amounts.get(account) ?? 0n) / unit : null,
  }));

  lines.push("");
  if (amounts) {
    const perDayOf = (r: PreviewRow): number => Number(amounts.get(r.account) ?? 0n) / unit;
    lines.push(
      `Budget per day: ${[...budgets].map(([k, v]) => `${k} ${Number(v) / unit}`).join(", ")} ${reward.symbol}`,
    );
    for (const [asset, total] of totals) {
      const perDay = Number(budgets.get(asset)) / unit;
      const eligibleUsd = usdNumber(total / n);
      let line = `  ${asset}: ${eligibleUsd > 0 ? ((perDay / eligibleUsd) * 1000).toFixed(4) : "-"} ${reward.symbol} per $1,000 eligible per day`;
      if (rewardPriceUsd !== null && eligibleUsd > 0) {
        line += `, about ${((perDay * 365 * rewardPriceUsd * 100) / eligibleUsd).toFixed(2)}% APR at $${rewardPriceUsd}`;
      }
      lines.push(line);
    }
    const top = [...perAccount].sort((x, y) => perDayOf(y) - perDayOf(x)).slice(0, 10);
    const totalPerDay = perAccount.reduce((s, r) => s + perDayOf(r), 0);
    lines.push("");
    lines.push("Largest earners per day:");
    for (const r of top) {
      const who = `${r.account.slice(0, 10)}…${r.account.slice(-6)}`;
      const eligibleUsd = `$${r.eligibleUsd.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
      lines.push(
        `  ${who}  ${eligibleUsd.padStart(12)} eligible  ${perDayOf(r).toFixed(3).padStart(10)} ${reward.symbol}  ${pct(perDayOf(r), totalPerDay)}`,
      );
    }
  } else {
    const blanks = [...program.budgetPerDay].filter(([, budget]) => budget === null).map(([asset]) => asset);
    lines.push(
      `budget_per_day is blank for ${blanks.join(" and ")}, so no amounts are shown. ` +
        "Fill it in to see what each account would get.",
    );
  }
  if (denylist.provisional)
    lines.push('\nNote: the excluded-accounts list is provisional (see its "unresolved" entries).');
  return { text: lines.join("\n"), perAccount };
}

function main() {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const { values: a } = parseArgs({
    options: {
      program: { type: "string" },
      epoch: { type: "string" },
      snapshot: { type: "string" },
      csv: { type: "string" },
      "reward-price-usd": { type: "string" },
      data: { type: "string", default: join(root, "data") },
      config: { type: "string", default: join(root, "config", "mainnet.json") },
      denylist: { type: "string", default: join(root, "config", "denylist.json") },
    },
  });
  if (!a.program) throw new Error("--program is required");
  const config = readJson<Config>(a.config);
  const program = loadProgram(a.program, config);
  let price: number | null = null;
  if (a["reward-price-usd"] !== undefined) {
    price = Number(a["reward-price-usd"]);
    if (!(price > 0)) throw new Error(`--reward-price-usd must be a positive number, got ${a["reward-price-usd"]}`);
  }
  const { text, perAccount } = previewProgram(program, loadSnapshots(a, program, config.epoch.snapshotsPerEpoch), {
    denylist: loadDenylist(a.denylist),
    reward: config.reward,
    rewardPriceUsd: price,
  });
  console.log(text);
  if (a.csv) {
    const rows = [...perAccount].sort((x, y) => y.eligibleUsd - x.eligibleUsd);
    const lines = rows.map(
      (r) => `${r.account},${r.eligibleUsd.toFixed(2)},${r.rewardPerDay === null ? "" : r.rewardPerDay.toFixed(6)}`,
    );
    writeText(a.csv, `account,eligible_usd,${config.reward.symbol.toLowerCase()}_per_day\n${lines.join("\n")}\n`);
    console.log(`\nWrote ${rows.length} accounts to ${a.csv}`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(`preview: ${messageOf(error)}`);
    process.exit(1);
  }
}
