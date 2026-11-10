#!/usr/bin/env node
// Hourly snapshot: chain state at one block -> data/snapshots/<hour>.json
//
// The block is the first finalized block at or after the hour. At that block it reads:
//   - aHUSDC / aHUSDT balance of every indexed address, and each aToken's total supply
//   - HOLLAR variable debt on main, GIGAHDX and BIL (the only debt that counts; config debtAssets)
//   - each market's AaveOracle price for every asset involved
// Pools, oracles and token addresses are resolved at that block through each PoolAddressesProvider.
// It stops on any RPC error, when an oracle does not price in 8 decimals, and when holder balances
// do not add up to an aToken's total supply.
//
// Usage:
//   node src/snapshot.ts --at 2026-11-12T15:00:00Z     the hour, as a time or unix seconds
//   node src/snapshot.ts --index-only                   extend data/state/holders.json only
//   node src/snapshot.ts --index-only --rescan 50000    the same, scanning the last 50,000 indexed blocks again

import { existsSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { compareAddresses } from "./lib/accounts.ts";
import { loadDotEnv, messageOf, readJson, toJson, writeText } from "./lib/io.ts";
import { decodeAddress, decodeReserveData, decodeUint, ethCall, SELECTORS, ZERO_ADDRESS } from "./lib/abi.ts";
import { usdRounded } from "./lib/format.ts";
import { updateHolderIndex } from "./lib/holders.ts";
import { makeRpc, toBlockTag } from "./lib/rpc.ts";
import { SNAPSHOT_FORMAT } from "./eligibility.ts";
import type { Block, Config, Log, Rpc, Snapshot } from "./types.ts";

const ORACLE_UNIT = 10n ** 8n; // values are computed as 18-decimal amounts × 8-decimal prices
const DAY = 86_400;

async function getBlock(rpc: Pick<Rpc, "call">, tag: string): Promise<Block> {
  const b = (await rpc.call("eth_getBlockByNumber", [tag, false])) as {
    number: string;
    hash: string;
    timestamp: string;
  } | null;
  if (!b) throw new Error(`block ${tag} not found`);
  return { number: Number(BigInt(b.number)), hash: b.hash, timestamp: Number(BigInt(b.timestamp)) };
}

// The first block whose timestamp is at or after `target`, once it is finalized.
export async function blockAtOrAfter(rpc: Pick<Rpc, "call">, target: number): Promise<Block> {
  const finalized = await getBlock(rpc, "finalized");
  if (finalized.timestamp < target) {
    // The bot waits on this code instead of reporting a failure.
    throw Object.assign(
      new Error(`no finalized block at or after ${target} yet (the finalized head is at ${finalized.timestamp})`),
      { code: "NOT_FINALIZED" },
    );
  }
  let lo = 1;
  let hi = finalized.number;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if ((await getBlock(rpc, toBlockTag(mid))).timestamp >= target) hi = mid;
    else lo = mid + 1;
  }
  return getBlock(rpc, toBlockTag(hi));
}

const holderIndex = ({
  rpc,
  config,
  holdersPath,
  toBlock,
  log,
  rewind = 0,
}: {
  rpc: Pick<Rpc, "call">;
  config: Config;
  holdersPath: string;
  toBlock: number;
  log?: Log;
  rewind?: number;
}) => {
  const earning = Object.values(config.supplyAssets);
  return updateHolderIndex({
    rpc,
    path: holdersPath,
    tokens: earning.map((h) => h.aToken),
    fromBlock: Math.min(...earning.map((h) => h.deployBlock)),
    toBlock,
    rewind,
    maxSpan: config.logs.maxBlockSpan,
    concurrency: config.logs.concurrency,
    log,
  });
};

// A reserve while its snapshot is being put together.
interface ReserveState {
  aToken: string;
  underlying: string;
  market: string;
  price: bigint;
  decimals: number;
  totalSupply: bigint;
  holdersSum: bigint;
}

export async function takeSnapshot({
  rpc,
  config,
  block,
  target,
  holdersPath,
  log = () => {},
}: {
  rpc: Rpc;
  config: Config;
  block: Block;
  target: number;
  holdersPath: string;
  log?: Log;
}): Promise<Snapshot> {
  const N = block.number;
  const earning = Object.entries(config.supplyAssets);
  const marketNames = Object.keys(config.markets);

  const index = await holderIndex({ rpc, config, holdersPath, toBlock: N, log });

  // 1. Pool and oracle of each market at N; every oracle must price in 8 decimals.
  const marketResults = await rpc.batch(
    marketNames.flatMap((m) => [
      ethCall(config.markets[m].poolAddressesProvider, SELECTORS.getPool, [], N),
      ethCall(config.markets[m].poolAddressesProvider, SELECTORS.getPriceOracle, [], N),
    ]),
  );
  const markets: Snapshot["markets"] = {};
  marketNames.forEach((m, i) => {
    const pool = decodeAddress(marketResults[2 * i], `${m} getPool`);
    const oracle = decodeAddress(marketResults[2 * i + 1], `${m} getPriceOracle`);
    if (pool === ZERO_ADDRESS || oracle === ZERO_ADDRESS) throw new Error(`${m}: no pool or oracle at block ${N}`);
    markets[m] = { pool, oracle };
  });
  const units = await rpc.batch(marketNames.map((m) => ethCall(markets[m].oracle, SELECTORS.baseCurrencyUnit, [], N)));
  marketNames.forEach((m, i) => {
    const unit = decodeUint(units[i], `${m} oracle unit`);
    if (unit !== ORACLE_UNIT) throw new Error(`${m}: oracle prices in units of ${unit}, expected ${ORACLE_UNIT}`);
  });

  // 2. Reserve tokens: H-token aTokens on their market, debt tokens on every market.
  const debtEntries = Object.entries(config.debtAssets).flatMap(([asset, d]) =>
    marketNames.map((market) => ({ asset, market, d })),
  );
  const reserveResults = await rpc.batch([
    ...earning.map(([, h]) => ethCall(markets[h.market].pool, SELECTORS.getReserveData, [h.underlying], N)),
    ...debtEntries.map(({ market, d }) => ethCall(markets[market].pool, SELECTORS.getReserveData, [d.underlying], N)),
  ]);
  const reserves: Record<string, ReserveState> = {};
  earning.forEach(([name, h], i) => {
    const { aToken } = decodeReserveData(reserveResults[i], `${name} reserve`);
    if (aToken !== h.aToken.toLowerCase())
      throw new Error(`${name}: aToken at block ${N} is ${aToken}, config says ${h.aToken}`);
    // Price, decimals and supplies are read in the next step, and the price is checked to be above zero.
    reserves[name] = {
      aToken,
      underlying: h.underlying.toLowerCase(),
      market: h.market,
      price: 0n,
      decimals: 0,
      totalSupply: 0n,
      holdersSum: 0n,
    };
  });
  const debts = debtEntries.map(({ asset, market, d }, i) => {
    const { aToken, variableDebtToken } = decodeReserveData(
      reserveResults[earning.length + i],
      `${asset}@${market} reserve`,
    );
    if (aToken === ZERO_ADDRESS) throw new Error(`${asset} is not listed on ${market} at block ${N}`);
    return {
      asset,
      market,
      debtToken: variableDebtToken,
      underlying: d.underlying.toLowerCase(),
      decimals: d.decimals,
      price: 0n,
    };
  });

  // 3. Prices, decimals and total supplies.
  const meta = await rpc.batch([
    ...earning.flatMap(([name]) => {
      const r = reserves[name];
      return [
        ethCall(markets[r.market].oracle, SELECTORS.getAssetPrice, [r.underlying], N),
        ethCall(r.aToken, SELECTORS.decimals, [], N),
        ethCall(r.aToken, SELECTORS.totalSupply, [], N),
      ];
    }),
    ...debts.flatMap((x) => [
      ethCall(markets[x.market].oracle, SELECTORS.getAssetPrice, [x.underlying], N),
      ethCall(x.debtToken, SELECTORS.decimals, [], N),
    ]),
  ]);
  earning.forEach(([name], i) => {
    const r = reserves[name];
    r.price = decodeUint(meta[3 * i], `${name} price`);
    r.decimals = Number(decodeUint(meta[3 * i + 1], `${name} decimals`));
    r.totalSupply = decodeUint(meta[3 * i + 2], `${name} totalSupply`);
    if (r.price <= 0n) throw new Error(`${name}: oracle price is zero at block ${N}`);
  });
  debts.forEach((x, j) => {
    const at = 3 * earning.length + 2 * j;
    x.price = decodeUint(meta[at], `${x.asset}@${x.market} price`);
    const decimals = Number(decodeUint(meta[at + 1], `${x.asset}@${x.market} decimals`));
    if (decimals !== x.decimals)
      throw new Error(`${x.asset}@${x.market}: debt token has ${decimals} decimals, config says ${x.decimals}`);
    if (x.price <= 0n) throw new Error(`${x.asset}@${x.market}: oracle price is zero at block ${N}`);
  });

  // 4. H-token balances of every indexed address; the sum must match total supply.
  const candidates = index.addresses;
  const balanceResults = await rpc.batch(
    candidates.flatMap((account) =>
      earning.map(([name]) => ethCall(reserves[name].aToken, SELECTORS.balanceOf, [account], N)),
    ),
  );
  const supply = new Map<string, Record<string, bigint>>();
  earning.forEach(([name]) => (reserves[name].holdersSum = 0n));
  candidates.forEach((account, i) => {
    const perReserve: Record<string, bigint> = {};
    let any = false;
    earning.forEach(([name], k) => {
      const balance = decodeUint(balanceResults[i * earning.length + k], `${name} balanceOf ${account}`);
      reserves[name].holdersSum += balance;
      perReserve[name] = balance;
      if (balance > 0n) any = true;
    });
    if (any) supply.set(account, perReserve);
  });
  for (const [name] of earning) {
    const r = reserves[name];
    const gap = r.holdersSum > r.totalSupply ? r.holdersSum - r.totalSupply : r.totalSupply - r.holdersSum;
    // Each balanceOf and totalSupply rounds by at most half a wei, so the gap is bounded by the holder count.
    if (gap > BigInt(supply.size + 1)) {
      throw new Error(
        `${name}: holder balances add up to ${r.holdersSum}, total supply is ${r.totalSupply} at block ${N}; ` +
          "the holder index is missing accounts (scan its tail again with --index-only --rescan <blocks>)",
      );
    }
  }

  // 5. Debts of every H-token holder.
  const holders = [...supply.keys()].sort(compareAddresses);
  const debtResults = await rpc.batch(
    holders.flatMap((account) => debts.map((x) => ethCall(x.debtToken, SELECTORS.balanceOf, [account], N))),
  );

  const accounts: Snapshot["accounts"] = {};
  holders.forEach((account, i) => {
    const debt: Record<string, Record<string, string>> = {};
    debts.forEach((x, j) => {
      debt[x.asset] ??= {};
      debt[x.asset][x.market] = decodeUint(
        debtResults[i * debts.length + j],
        `${x.asset}@${x.market} debt ${account}`,
      ).toString();
    });
    const held = supply.get(account);
    if (!held) throw new Error(`no balances were read for ${account}`);
    accounts[account] = {
      supply: Object.fromEntries(earning.map(([name]) => [name, held[name].toString()])),
      debt,
    };
  });

  const debtAssets: Snapshot["debtAssets"] = {};
  for (const x of debts) {
    debtAssets[x.asset] ??= { decimals: x.decimals, markets: {} };
    debtAssets[x.asset].markets[x.market] = { debtToken: x.debtToken, price: x.price.toString() };
  }

  return {
    format: SNAPSHOT_FORMAT,
    target,
    block,
    markets,
    reserves: Object.fromEntries(
      earning.map(([name]) => {
        const r = reserves[name];
        return [
          name,
          {
            aToken: r.aToken,
            underlying: r.underlying,
            market: r.market,
            decimals: r.decimals,
            price: r.price.toString(),
            totalSupply: r.totalSupply.toString(),
            holdersSum: r.holdersSum.toString(),
          },
        ];
      }),
    ),
    debtAssets,
    holders: holders.length,
    accounts,
  };
}

// Takes the snapshot for one hour and stores it as <dataDir>/snapshots/<target>.json.
export async function snapshotHour({
  rpc,
  config,
  dataDir,
  target,
  log = () => {},
}: {
  rpc: Rpc;
  config: Config;
  dataDir: string;
  target: number;
  log?: Log;
}): Promise<{ path: string; snapshot: Snapshot }> {
  // Epochs start on an hour and take evenly spaced snapshots, so anything else would never be used.
  const interval = DAY / config.epoch.snapshotsPerEpoch;
  if (!Number.isInteger(target) || target % interval !== 0) {
    throw new Error(`a snapshot time must be a multiple of ${interval} seconds (on the hour), got ${target}`);
  }
  const block = await blockAtOrAfter(rpc, target);
  if (block.timestamp >= target + interval) {
    // The closer only accepts a block inside its hour, so storing this one would wedge the epoch.
    throw Object.assign(
      new Error(
        `the chain produced no block between ${target} and ${target + interval} (the next one is at ${block.timestamp}); ` +
          "this hour cannot be snapshotted, so its epoch has to be closed with --allow-partial",
      ),
      { code: "NO_BLOCK_IN_HOUR" },
    );
  }
  const holdersPath = join(dataDir, "state", "holders.json");
  const snapshot = await takeSnapshot({ rpc, config, block, target, holdersPath, log });
  const path = join(dataDir, "snapshots", `${target}.json`);
  if (existsSync(path)) log(`replacing ${path}`);
  writeText(path, toJson(snapshot));
  return { path, snapshot };
}

function parseTime(text: string): number {
  if (/^\d+$/.test(text)) return Number(text);
  const ms = Date.parse(text);
  if (Number.isNaN(ms)) throw new Error(`cannot read time ${text}`);
  return Math.floor(ms / 1000);
}

async function main() {
  const root = fileURLToPath(new URL("..", import.meta.url));
  loadDotEnv(root);
  const { values: a } = parseArgs({
    options: {
      at: { type: "string" },
      "index-only": { type: "boolean", default: false },
      rescan: { type: "string" },
      data: { type: "string", default: join(root, "data") },
      config: { type: "string", default: join(root, "config", "mainnet.json") },
      rpc: { type: "string" },
    },
  });
  const config = readJson<Config>(a.config);
  const rpc = makeRpc(a.rpc ?? process.env.RPC_HYDRATION ?? config.rpc, { batchSize: config.rpcBatchSize });
  const holdersPath = join(a.data, "state", "holders.json");
  const log: Log = (line) => console.error(line);

  if (a["index-only"]) {
    const toBlock = (await getBlock(rpc, "finalized")).number;
    const rewind = a.rescan === undefined ? 0 : Number(a.rescan);
    if (!Number.isInteger(rewind) || rewind < 0) throw new Error(`--rescan takes a number of blocks, got ${a.rescan}`);
    const state = await holderIndex({ rpc, config, holdersPath, toBlock, log, rewind });
    console.log(`holder index: ${state.addresses.length} addresses, scanned to block ${state.scannedTo}`);
    return;
  }

  if (!a.at) throw new Error("pass --at <time>");
  const { path, snapshot } = await snapshotHour({ rpc, config, dataDir: a.data, target: parseTime(a.at), log });
  const { block } = snapshot;

  const value = (name: string): bigint =>
    Object.values(snapshot.accounts).reduce(
      (s, h) =>
        s +
        BigInt(h.supply[name]) *
          BigInt(snapshot.reserves[name].price) *
          10n ** BigInt(18 - snapshot.reserves[name].decimals),
      0n,
    );
  const debt = Object.entries(snapshot.debtAssets).map(([asset, meta]) => {
    const total = Object.values(snapshot.accounts).reduce(
      (s, h) =>
        s +
        Object.entries(h.debt[asset]).reduce(
          (t, [m, v]) => t + BigInt(v) * BigInt(meta.markets[m].price) * 10n ** BigInt(18 - meta.decimals),
          0n,
        ),
      0n,
    );
    return `  ${asset} debt of those holders: ${usdRounded(total)}`;
  });
  console.log(
    [
      path,
      `  block ${block.number} (${new Date(block.timestamp * 1000).toISOString()}), ${snapshot.holders} holders`,
      ...Object.keys(snapshot.reserves).map((n) => `  ${n}: ${usdRounded(value(n))} supplied`),
      ...debt,
    ].join("\n"),
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`snapshot: ${messageOf(error)}`);
    process.exit(1);
  });
}
