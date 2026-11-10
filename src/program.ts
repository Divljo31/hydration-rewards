// Reads a rewards program file (programs/*.yaml) and checks every setting before anything runs.
// A misspelt key, an unknown asset or a missing setting stops the run: a setting that is silently
// ignored would pay accounts it should not. See programs/README.md for the file format.

import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { sha256 } from "./lib/io.ts";
import type { Config, Program } from "./types.ts";

const PROGRAM_KEYS = ["name", "budget_per_day", "epoch_start_hour_utc", "earn_on_supply_of", "max_hollar_debt_usd"];

function distance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return d[a.length][b.length];
}

function notKnown(what: string, value: unknown, known: string[]): Error {
  const close = known.filter((k) => distance(String(value).toLowerCase(), k.toLowerCase()) <= 2);
  const hint = close.length ? ` Did you mean ${close.join(" or ")}?` : ` Use one of: ${known.join(", ")}.`;
  return new Error(`${what} "${value}" is not known.${hint}`);
}

const blank = (v: unknown): boolean => v === null || v === undefined || v === "";

// "275.616" -> 275616000n for 6 decimals; refuses more decimal places than `decimals`.
export function toRawUnits(text: unknown, decimals: number, where: string): bigint {
  const s = String(text).trim();
  const m = /^(\d+)(?:\.(\d+))?$/.exec(s);
  if (!m) throw new Error(`${where}: "${s}" is not a plain number like 275.616`);
  const fraction = m[2] ?? "";
  if (fraction.length > decimals) throw new Error(`${where}: ${s} has more than ${decimals} decimal places`);
  return BigInt(m[1]) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, "0") || "0");
}

// text: the file's contents. config: config/mainnet.json. Returns a checked program.
// With requireDecisions, a blank budget or start hour is an error (closing an epoch);
// without it they come back as null (previewing).
export function parseProgram(
  text: string,
  config: Config,
  { source = "program", requireDecisions = false }: { source?: string; requireDecisions?: boolean } = {},
): Program {
  // The failsafe schema keeps every value as text, so 275.616 never passes through a float.
  const doc = parse(text, { schema: "failsafe" });
  if (!doc || typeof doc !== "object" || Array.isArray(doc))
    throw new Error(`${source}: expected settings like "name: ..."`);

  for (const key of Object.keys(doc))
    if (!PROGRAM_KEYS.includes(key)) throw notKnown(`${source}: setting`, key, PROGRAM_KEYS);
  for (const key of PROGRAM_KEYS) {
    if (!(key in doc) && key !== "epoch_start_hour_utc") throw new Error(`${source}: "${key}" is missing`);
  }

  const supplyAssets = Object.keys(config.supplyAssets);
  const listed = Array.isArray(doc.earn_on_supply_of) ? doc.earn_on_supply_of : [doc.earn_on_supply_of];
  if (listed.length === 0 || listed.some(blank))
    throw new Error(`${source}: earn_on_supply_of needs at least one asset`);
  const earn: string[] = listed.map(String);
  for (const [i, asset] of earn.entries()) {
    if (!supplyAssets.includes(asset)) {
      throw new Error(
        `${notKnown(`${source}: earn_on_supply_of asset`, asset, supplyAssets).message} ` +
          "The snapshot only records supply of these; ask a developer to add others to config/mainnet.json.",
      );
    }
    if (earn.indexOf(asset) !== i) throw new Error(`${source}: earn_on_supply_of lists ${asset} twice`);
  }

  const budgets = doc.budget_per_day;
  if (!budgets || typeof budgets !== "object" || Array.isArray(budgets)) {
    throw new Error(`${source}: budget_per_day needs one line per earning asset`);
  }
  for (const key of Object.keys(budgets))
    if (!earn.includes(key)) throw notKnown(`${source}: budget_per_day asset`, key, earn);
  const budgetPerDay = new Map<string, bigint | null>();
  for (const asset of earn) {
    if (!(asset in budgets)) throw new Error(`${source}: budget_per_day has no line for ${asset}`);
    if (blank(budgets[asset])) {
      if (requireDecisions)
        throw new Error(`${source}: budget_per_day for ${asset} is blank; fill it in before closing an epoch`);
      budgetPerDay.set(asset, null);
    } else {
      budgetPerDay.set(asset, toRawUnits(budgets[asset], config.reward.decimals, `${source}: budget_per_day ${asset}`));
    }
  }

  let startHourUtc: number | null = null;
  if (!blank(doc.epoch_start_hour_utc)) {
    const h = String(doc.epoch_start_hour_utc);
    if (!/^\d{1,2}$/.test(h) || Number(h) > 23)
      throw new Error(`${source}: epoch_start_hour_utc must be a whole hour from 0 to 23`);
    startHourUtc = Number(h);
  } else if (requireDecisions) {
    throw new Error(`${source}: epoch_start_hour_utc is blank; fill it in before closing an epoch`);
  }

  // Never optional: a blank here must not turn into "HOLLAR borrowers earn too".
  if (blank(doc.max_hollar_debt_usd)) {
    throw new Error(
      `${source}: max_hollar_debt_usd is blank; write a dollar amount (0 means any HOLLAR debt disqualifies)`,
    );
  }
  const maxHollarDebt = toRawUnits(doc.max_hollar_debt_usd, 2, `${source}: max_hollar_debt_usd`) * 10n ** 24n;

  if (blank(doc.name)) throw new Error(`${source}: name is blank`);
  return { name: String(doc.name), earn, budgetPerDay, startHourUtc, maxHollarDebt, sha256: sha256(text) };
}

export function loadProgram(path: string, config: Config, options: { requireDecisions?: boolean } = {}): Program {
  return parseProgram(readFileSync(path, "utf8"), config, { source: path, ...options });
}
