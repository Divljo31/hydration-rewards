// Pure eligibility calculation over stored snapshots. No network, no clock.
//
// For each account at each snapshot:
//   V_r      = supplied balance_r × oracle price_r           for every asset that earns
//   D        = HOLLAR debt on every market the snapshot recorded, at that market's oracle price
//   eligible = V_r when D is at most the allowed amount, otherwise 0 for that snapshot
// Per-asset results are summed over the epoch's snapshots (time weighting), so an account earns
// for the hours it had no HOLLAR debt.
//
// The allowed amount has no default and no "off" value: a caller that forgets it must fail, never
// pay HOLLAR borrowers. Values stay exact integers (see lib/format.ts); nothing is rounded here.

import { compareAddresses, normalizeAddress } from "./lib/accounts.ts";
import type { Denylist, PerAccount, Snapshot } from "./types.ts";

// /2: the block is picked inside the hour from the hash of the block after it, and recorded how
// (src/lib/selection.ts). /1 snapshots, taken at the first block of the hour, are not read.
export const SNAPSHOT_FORMAT = "hydration-rewards-snapshot/2";
export const DEBT_ASSET = "HOLLAR";

const toScale = (decimals: number): bigint => {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) throw new Error(`bad decimals ${decimals}`);
  return 10n ** BigInt(18 - decimals);
};

function amount(value: unknown, where: string): bigint {
  if (typeof value !== "string" || !/^\d+$/.test(value)) throw new Error(`${where}: expected an integer string`);
  return BigInt(value);
}

// One snapshot -> {
//   eligible:  Map<account, Map<asset, bigint>>   every account that is not excluded (zeros for borrowers)
//   excluded:  Map<account, {reason, value}>      denylisted accounts and their supplied value
//   borrowers: { accounts: Set, value }           accounts over the HOLLAR allowance and the value they lose
//   debts:     Map<account, bigint>               HOLLAR debt of every account in `eligible`
//   gross:     bigint                             supplied value of every account that is not excluded
// }
export interface EligibilityOptions {
  // HOLLAR debt an account may have and still earn, in value units. Required: there is no default.
  maxHollarDebt: bigint;
  denylist: Pick<Denylist, "reasonFor">;
  // Earning assets; every reserve the snapshot recorded when left out.
  earn?: string[];
}

interface Borrowers {
  accounts: Set<string>;
  value: bigint;
}

type Excluded = Map<string, { reason: string; value: bigint }>;

export function snapshotEligibility(
  snapshot: Snapshot,
  { maxHollarDebt, earn, denylist }: EligibilityOptions,
): {
  eligible: PerAccount;
  excluded: Excluded;
  borrowers: Borrowers;
  debts: Map<string, bigint>;
  gross: bigint;
  reserves: string[];
} {
  if (snapshot?.format !== SNAPSHOT_FORMAT) throw new Error(`not a ${SNAPSHOT_FORMAT} snapshot`);
  if (!denylist) throw new Error("a denylist is required");
  if (typeof maxHollarDebt !== "bigint" || maxHollarDebt < 0n) throw new Error("the allowed HOLLAR debt is required");
  const at = `snapshot @${snapshot.block?.number}`;

  const earnNames = earn ?? Object.keys(snapshot.reserves ?? {});
  if (new Set(earnNames).size !== earnNames.length) throw new Error(`${at}: an earning asset is listed twice`);
  const reserves = earnNames.map((name) => {
    const r = snapshot.reserves?.[name];
    if (!r) throw new Error(`${at}: the snapshot did not record supply of ${name}`);
    return { name, price: amount(r.price, `${at} ${name}.price`), scale: toScale(r.decimals) };
  });
  if (reserves.length === 0) throw new Error(`${at}: nothing earns`);

  const debtMeta = snapshot.debtAssets?.[DEBT_ASSET];
  if (!debtMeta) throw new Error(`${at}: the snapshot did not record ${DEBT_ASSET} debt`);
  const debtScale = toScale(debtMeta.decimals);
  const debtMarkets = Object.entries(debtMeta.markets ?? {}).map(([market, m]) => ({
    market,
    price: amount(m.price, `${at} ${DEBT_ASSET}.${market}.price`),
  }));
  if (debtMarkets.length === 0) throw new Error(`${at}: ${DEBT_ASSET} has no markets`);

  const eligible: PerAccount = new Map();
  const excluded: Excluded = new Map();
  const borrowers: Borrowers = { accounts: new Set(), value: 0n };
  const debts = new Map<string, bigint>();
  let gross = 0n;

  for (const [rawAccount, holdings] of Object.entries(snapshot.accounts ?? {})) {
    const account = normalizeAddress(rawAccount);
    const where = `${at} ${account}`;

    const values = new Map<string, bigint>();
    let total = 0n;
    for (const r of reserves) {
      const v = amount(holdings.supply?.[r.name], `${where} supply.${r.name}`) * r.scale * r.price;
      values.set(r.name, v);
      total += v;
    }

    const reason = denylist.reasonFor(account);
    if (reason) {
      excluded.set(account, { reason, value: total });
      continue;
    }
    if (total === 0n) continue;
    gross += total;

    let debt = 0n;
    for (const m of debtMarkets) {
      debt +=
        amount(holdings.debt?.[DEBT_ASSET]?.[m.market], `${where} debt.${DEBT_ASSET}.${m.market}`) *
        debtScale *
        m.price;
    }
    debts.set(account, debt);
    if (debt > maxHollarDebt) {
      borrowers.accounts.add(account);
      borrowers.value += total;
      eligible.set(account, new Map(reserves.map((r): [string, bigint] => [r.name, 0n])));
    } else {
      eligible.set(account, values);
    }
  }
  return { eligible, excluded, borrowers, debts, gross, reserves: reserves.map((r) => r.name) };
}

// Many snapshots -> time-weighted sums per account and asset, per-asset totals, and what the
// HOLLAR rule removed.
export function epochEligibility(
  snapshots: Snapshot[],
  options: EligibilityOptions,
): { eligible: PerAccount; totals: Map<string, bigint>; excluded: Excluded; borrowers: Borrowers; gross: bigint } {
  const sums: PerAccount = new Map();
  const totals = new Map<string, bigint>();
  const excluded: Excluded = new Map();
  const borrowers: Borrowers = { accounts: new Set(), value: 0n };
  let gross = 0n;
  let reserveNames: string | null = null;

  for (const snapshot of snapshots) {
    const result = snapshotEligibility(snapshot, options);
    const key = [...result.reserves].sort().join(",");
    if (reserveNames === null) reserveNames = key;
    if (key !== reserveNames) throw new Error(`snapshots disagree on earning assets: ${reserveNames} vs ${key}`);

    for (const name of result.reserves) if (!totals.has(name)) totals.set(name, 0n);
    for (const [account, perAsset] of result.eligible) {
      const acc = sums.get(account) ?? new Map<string, bigint>();
      for (const [name, e] of perAsset) {
        acc.set(name, (acc.get(name) ?? 0n) + e);
        totals.set(name, (totals.get(name) ?? 0n) + e);
      }
      sums.set(account, acc);
    }
    for (const [account, { reason, value }] of result.excluded) {
      const prev = excluded.get(account);
      excluded.set(account, { reason, value: (prev?.value ?? 0n) + value });
    }
    for (const a of result.borrowers.accounts) borrowers.accounts.add(a);
    borrowers.value += result.borrowers.value;
    gross += result.gross;
  }

  const ordered = new Map([...sums.entries()].sort(([a], [b]) => compareAddresses(a, b)));
  return { eligible: ordered, totals, excluded, borrowers, gross };
}
