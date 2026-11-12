// Every address that ever received aHUSDC or aHUSDT, built from Transfer logs and kept in
// data/state/holders.json so each snapshot only scans the blocks since the last one.
//
// Hydration's node serves Substrate-originated EVM activity as synthetic transactions (sender
// 0x73796e74…7468, "synth"), so transfers made from Substrate wallets appear in eth_getLogs too.
// Completeness is still checked at every snapshot: holder balances must add up to total supply.
// The public RPC gives each log query 10 seconds, which ranges of 10k blocks often exceed, so the
// scan uses fixed windows (config logs.maxBlockSpan), a few in parallel, and splits a window that
// times out. A window already at the minimum size is retried a few times before the scan gives up.
// Progress is saved after every batch, so an interrupted scan resumes where it stopped.

import { existsSync } from "node:fs";
import { compareAddresses } from "./accounts.ts";
import { acquireLock, readJson, toJson, writeText } from "./io.ts";
import { TRANSFER_TOPIC, ZERO_ADDRESS } from "./abi.ts";
import { toBlockTag } from "./rpc.ts";
import type { Log, Rpc } from "../types.ts";

// data/state/holders.json
export interface HolderIndex {
  format: string;
  tokens: string[];
  fromBlock: number;
  scannedTo: number;
  addresses: string[];
}

interface TransferLog {
  address: string;
  topics: string[];
}

const HOLDERS_FORMAT = "hydration-rewards-holders/1";

const isQueryLimit = (error: unknown): boolean =>
  /timeout|too many|limit/i.test(String((error as { message?: unknown } | null)?.message));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// One scan at a time: two processes extending the same index (the runner, and a --rescan run by hand)
// would each save their own address set, and the last save would drop what the other one found.
export async function updateHolderIndex(options: Parameters<typeof scanHolders>[0]): Promise<HolderIndex> {
  const release = acquireLock(`${options.path}.lock`, "the holder index");
  try {
    return await scanHolders(options);
  } finally {
    release();
  }
}

async function scanHolders({
  rpc,
  path,
  tokens,
  fromBlock,
  toBlock,
  maxSpan = 10_000,
  concurrency = 4,
  minSpan = 500,
  retries = 3,
  retryDelayMs = 2_000,
  rewind = 0,
  log = () => {},
}: {
  rpc: Pick<Rpc, "call">;
  path: string;
  tokens: string[];
  fromBlock: number;
  toBlock: number;
  maxSpan?: number;
  concurrency?: number;
  minSpan?: number;
  retries?: number;
  retryDelayMs?: number;
  rewind?: number;
  log?: Log;
}): Promise<HolderIndex> {
  const tokenList = tokens.map((t) => t.toLowerCase()).sort();
  const state: HolderIndex = existsSync(path)
    ? readJson<HolderIndex>(path)
    : { format: HOLDERS_FORMAT, tokens: tokenList, fromBlock, scannedTo: fromBlock - 1, addresses: [] };
  if (state.format !== HOLDERS_FORMAT) throw new Error(`${path}: not a ${HOLDERS_FORMAT} file`);
  if (state.tokens.join() !== tokenList.join()) throw new Error(`${path}: built for other tokens`);

  // Scanning a stretch again only ever adds addresses, so it is safe whenever the index is in doubt.
  if (rewind > 0) state.scannedTo = Math.max(state.fromBlock - 1, state.scannedTo - rewind);

  const addresses = new Set(state.addresses);
  const save = () => {
    state.addresses = [...addresses].sort(compareAddresses);
    writeText(path, toJson(state));
  };

  // One window of blocks. A window the node cannot answer in time is split in two; one that is
  // already at the minimum size is retried, then fails the scan.
  async function fetchWindow(from: number, to: number, attempt = 0): Promise<TransferLog[]> {
    try {
      return (await rpc.call("eth_getLogs", [
        { address: tokenList, topics: [TRANSFER_TOPIC], fromBlock: toBlockTag(from), toBlock: toBlockTag(to) },
      ])) as TransferLog[];
    } catch (error) {
      if (!isQueryLimit(error)) throw error;
      if (to - from + 1 > minSpan) {
        const mid = from + Math.floor((to - from) / 2);
        return [...(await fetchWindow(from, mid)), ...(await fetchWindow(mid + 1, to))];
      }
      if (attempt >= retries) throw error;
      await sleep(retryDelayMs * 2 ** attempt);
      return fetchWindow(from, to, attempt + 1);
    }
  }

  let from = state.scannedTo + 1;
  let batches = 0;
  while (from <= toBlock) {
    const windows: [number, number][] = [];
    for (let i = 0; i < concurrency && from <= toBlock; i++) {
      const to = Math.min(from + maxSpan - 1, toBlock);
      windows.push([from, to]);
      from = to + 1;
    }
    // All windows of a batch must succeed before the index advances past them.
    const results = await Promise.all(windows.map(([f, t]) => fetchWindow(f, t)));
    for (const logs of results) {
      for (const entry of logs) {
        if (!tokenList.includes(entry.address.toLowerCase()))
          throw new Error(`log from unexpected contract ${entry.address}`);
        if (entry.topics[0] !== TRANSFER_TOPIC || entry.topics.length < 3) continue;
        const recipient = `0x${entry.topics[2].slice(26)}`.toLowerCase();
        if (recipient !== ZERO_ADDRESS) addresses.add(recipient);
      }
    }
    state.scannedTo = windows[windows.length - 1][1];
    save();
    if (++batches % 10 === 0) log(`holders: scanned to ${state.scannedTo}, ${addresses.size} addresses`);
  }
  save();
  return state;
}
