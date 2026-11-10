// Builds snapshots in the same shape src/snapshot.ts writes, with dollar amounts (cents allowed).
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SNAPSHOT_FORMAT } from "../src/eligibility.ts";
import type { DenylistFile } from "../src/lib/denylist.ts";
import { VALUE_UNIT } from "../src/lib/format.ts";
import { toJson } from "../src/lib/io.ts";
import type { Snapshot, SnapshotAccount, SnapshotReserve } from "../src/types.ts";

export const PRICE_1USD = 100_000_000n; // AaveOracle base currency has 8 decimals
export const $ = (dollars: number): bigint => BigInt(dollars) * VALUE_UNIT;

const t18 = (dollars: number): string => (BigInt(Math.round(dollars * 100)) * 10n ** 16n).toString();

// What one account holds, in dollars.
export interface Holding {
  husdc?: number;
  husdt?: number;
  hollar?: number;
  hollarGigahdx?: number;
  hollarBil?: number;
}

// account -> holding
export type Holdings = Record<string, Holding>;

export function holding({
  husdc = 0,
  husdt = 0,
  hollar = 0,
  hollarGigahdx = 0,
  hollarBil = 0,
}: Holding = {}): SnapshotAccount {
  return {
    supply: { HUSDC: t18(husdc), HUSDT: t18(husdt) },
    debt: { HOLLAR: { main: t18(hollar), gigahdx: t18(hollarGigahdx), bil: t18(hollarBil) } },
  };
}

// `target` is the hour the snapshot was taken for; the block is the first one at or after it.
// Addresses and supplies of the reserves are placeholders: nothing downstream of a snapshot reads them.
export function makeSnapshot({
  number,
  timestamp,
  target = timestamp,
  accounts,
  prices = {},
}: {
  number: number;
  timestamp: number;
  target?: number;
  accounts: Holdings;
  prices?: Record<string, bigint>;
}): Snapshot {
  const p = (name: string): string => String(prices[name] ?? PRICE_1USD);
  const token = (n: number): string => `0x${n.toString(16).padStart(40, "0")}`;
  const reserve = (name: string, n: number): SnapshotReserve => ({
    aToken: token(0xa0 + n),
    underlying: token(0x60 + n),
    market: "main",
    decimals: 18,
    price: p(name),
    totalSupply: "0",
    holdersSum: "0",
  });
  const debt = (n: number) => ({ debtToken: token(0xd0 + n), price: p("HOLLAR") });
  return {
    format: SNAPSHOT_FORMAT,
    target,
    block: { number, hash: `0x${number.toString(16).padStart(64, "0")}`, timestamp },
    markets: {},
    reserves: { HUSDC: reserve("HUSDC", 1), HUSDT: reserve("HUSDT", 2) },
    debtAssets: { HOLLAR: { decimals: 18, markets: { main: debt(1), gigahdx: debt(2), bil: debt(3) } } },
    holders: Object.keys(accounts).length,
    accounts: Object.fromEntries(Object.entries(accounts).map(([address, h]) => [address, holding(h)])),
  };
}

// 24 hourly snapshots from `start`, with holdings chosen per hour.
export function hourly(start: number, holdingsAt: (hour: number) => Holdings, firstBlock = 1_000): Snapshot[] {
  return Array.from({ length: 24 }, (_, h) =>
    makeSnapshot({ number: firstBlock + h, timestamp: start + h * 3600, accounts: holdingsAt(h) }),
  );
}

// A throwaway data directory with snapshots filed by their hour, plus a denylist file.
// `into` adds to an existing data directory.
export function makeDataDir({
  snapshots,
  denylist = { rules: { palletAccounts: true }, addresses: [] },
  into = null,
}: {
  snapshots: Snapshot[];
  denylist?: DenylistFile;
  into?: string | null;
}): { dataDir: string; denylistPath: string } {
  const dataDir = into ?? mkdtempSync(join(tmpdir(), "hydration-rewards-"));
  const dir = join(dataDir, "snapshots");
  mkdirSync(dir, { recursive: true });
  for (const s of snapshots) writeFileSync(join(dir, `${s.target}.json`), toJson(s));
  const denylistPath = join(dataDir, "denylist.json");
  writeFileSync(denylistPath, toJson(denylist));
  return { dataDir, denylistPath };
}

// The epoch CSV back as Map<account, bigint>.
export function parseCsv(text: string): Map<string, bigint> {
  const [header, ...rows] = text.trimEnd().split("\n");
  if (header !== "account,amount") throw new Error(`unexpected CSV header ${header}`);
  return new Map(
    rows.map((row) => row.split(",")).map(([account, amount]): [string, bigint] => [account, BigInt(amount)]),
  );
}

export const ACCOUNTS = {
  a: "0x00000000000000000000000000000000000000a1",
  b: "0x00000000000000000000000000000000000000b2",
  c: "0x00000000000000000000000000000000000000c3",
  treasury: "0x6d6f646c70792f74727372790000000000000000",
  listed: "0x00000000000000000000000000000000000000d4",
};
