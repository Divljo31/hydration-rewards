// The snapshotter and holder index against an in-memory chain, so the fail-closed paths are tested
// without a network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { SELECTORS, TRANSFER_TOPIC, ZERO_ADDRESS } from "../src/lib/abi.ts";
import { updateHolderIndex } from "../src/lib/holders.ts";
import { RpcError } from "../src/lib/rpc.ts";
import { checkSelection } from "../src/lib/selection.ts";
import { snapshotHour, takeSnapshot } from "../src/snapshot.ts";
import type { Config, Rpc, RpcRequest } from "../src/types.ts";

const A = (n: number): string => `0x${n.toString(16).padStart(40, "0")}`;
const word = (v: bigint | string): string =>
  (typeof v === "bigint" ? v.toString(16) : v.replace(/^0x/, "")).padStart(64, "0");
const E18 = 10n ** 18n;
const PRICE = 100_000_000n;

const U = { HUSDC: A(0x6e), HUSDT: A(0x6f), HOLLAR: A(0xde) };
const AT = { HUSDC: A(0xa1), HUSDT: A(0xa2) };
const DEBT = { main: A(0xd1), gigahdx: A(0xd2), bil: A(0xd3) };
const USERS = { a: A(0x1111), b: A(0x2222), c: A(0x3333) };

const market = (n: number) => ({ pap: A(0x1000 + n), pool: A(0x2000 + n), oracle: A(0x3000 + n) });

interface FakeLog {
  address: string;
  block: number;
  to: string;
}

interface FakeMarket {
  pap: string;
  pool: string;
  oracle: string;
  reserves: Record<string, { aToken: string; debt?: string }>;
}

// The block range of an eth_getLogs request.
function rangeOf(params: unknown[]): [number, number] {
  const query = params[0] as { fromBlock: string; toBlock: string };
  return [Number(BigInt(query.fromBlock)), Number(BigInt(query.toBlock))];
}

function chain({
  holders = [USERS.a, USERS.b],
  hollarOnBil = true,
  failBalanceOf = null,
  logs = null,
  oracleUnit = 10n ** 8n,
}: {
  holders?: string[];
  hollarOnBil?: boolean;
  failBalanceOf?: ((token: string, account: string) => boolean) | null;
  logs?: FakeLog[] | null;
  oracleUnit?: bigint;
} = {}) {
  const markets: Record<string, FakeMarket> = {
    main: {
      ...market(1),
      reserves: {
        [U.HUSDC]: { aToken: AT.HUSDC },
        [U.HUSDT]: { aToken: AT.HUSDT },
        [U.HOLLAR]: { aToken: A(0xe1), debt: DEBT.main },
      },
    },
    gigahdx: { ...market(2), reserves: { [U.HOLLAR]: { aToken: A(0xe2), debt: DEBT.gigahdx } } },
    bil: { ...market(3), reserves: hollarOnBil ? { [U.HOLLAR]: { aToken: A(0xe3), debt: DEBT.bil } } : {} },
  };
  const prices: Record<string, bigint> = { [U.HUSDC]: 102_000_000n, [U.HUSDT]: PRICE, [U.HOLLAR]: PRICE };
  const balances: Record<string, Record<string, bigint>> = {
    [AT.HUSDC]: { [USERS.a]: 100n * E18, [USERS.c]: 7n * E18 },
    [AT.HUSDT]: { [USERS.b]: 50n * E18 },
    [DEBT.main]: { [USERS.a]: 30n * E18 },
    [DEBT.gigahdx]: { [USERS.a]: 5n * E18 },
    [DEBT.bil]: { [USERS.b]: 1n * E18 },
  };
  const totalSupply = (token: string): bigint => Object.values(balances[token] ?? {}).reduce((s, v) => s + v, 0n);

  const result = ({ to, data }: { to: string; data: string }): string => {
    const sel = data.slice(0, 10);
    const arg = data.length >= 74 ? `0x${data.slice(34, 74)}` : "";
    for (const m of Object.values(markets)) {
      if (to === m.pap && sel === SELECTORS.getPool) return `0x${word(m.pool)}`;
      if (to === m.pap && sel === SELECTORS.getPriceOracle) return `0x${word(m.oracle)}`;
      if (to === m.pool && sel === SELECTORS.getReserveData) {
        const r: { aToken?: string; debt?: string } = m.reserves[arg] ?? {};
        return `0x${[...Array(8).fill(word("0")), word(r.aToken ?? ZERO_ADDRESS), word(ZERO_ADDRESS), word(r.debt ?? ZERO_ADDRESS), ...Array(4).fill(word("0"))].join("")}`;
      }
      if (to === m.oracle && sel === SELECTORS.getAssetPrice) return `0x${word(prices[arg])}`;
      if (to === m.oracle && sel === SELECTORS.baseCurrencyUnit)
        return `0x${word(m === markets.bil ? oracleUnit : 10n ** 8n)}`;
    }
    if (sel === SELECTORS.decimals) return `0x${word(18n)}`;
    if (sel === SELECTORS.totalSupply) return `0x${word(totalSupply(to))}`;
    if (sel === SELECTORS.balanceOf) {
      if (failBalanceOf && failBalanceOf(to, arg)) throw new RpcError("eth_call", { message: "execution reverted" });
      return `0x${word(balances[to]?.[arg] ?? 0n)}`;
    }
    throw new RpcError("eth_call", { message: `unknown call ${to} ${sel}` });
  };

  const transferLogs = logs ?? holders.map((h, i) => ({ address: i % 2 ? AT.HUSDT : AT.HUSDC, block: 10 + i, to: h }));

  const config: Config = {
    rpc: "http://node.test",
    chainId: 222222,
    reward: { symbol: "PRIME", assetId: 43, address: A(0x2b), decimals: 6 },
    epoch: { snapshotsPerEpoch: 24 },
    logs: { maxBlockSpan: 8 },
    markets: {
      main: { poolAddressesProvider: markets.main.pap },
      gigahdx: { poolAddressesProvider: markets.gigahdx.pap },
      bil: { poolAddressesProvider: markets.bil.pap },
    },
    supplyAssets: {
      HUSDC: { market: "main", underlying: U.HUSDC, aToken: AT.HUSDC, deployBlock: 1 },
      HUSDT: { market: "main", underlying: U.HUSDT, aToken: AT.HUSDT, deployBlock: 1 },
    },
    debtAssets: { HOLLAR: { underlying: U.HOLLAR, decimals: 18 } },
  };

  const rpc: Rpc = {
    async call(method: string, params: unknown[]) {
      if (method === "eth_getLogs") {
        const { address } = params[0] as { address: string[] };
        const [from, to] = rangeOf(params);
        return transferLogs
          .filter((l) => l.block >= from && l.block <= to && address.includes(l.address))
          .map((l) => ({ address: l.address, topics: [TRANSFER_TOPIC, `0x${word(ZERO_ADDRESS)}`, `0x${word(l.to)}`] }));
      }
      throw new Error(`unexpected ${method}`);
    },
    async batch(requests: RpcRequest[]) {
      return requests.map((r) => result(r.params[0] as { to: string; data: string }));
    },
  };
  return { rpc, config };
}

const BLOCK = { number: 40, hash: `0x${"ab".repeat(32)}`, timestamp: 1_800_000_000 };
// Block 40 is the third of the hour's five (38 to 42); the seed block 43's hash picks it.
const SELECTION = { firstBlock: 38, blocks: 5, seed: { number: 43, hash: `0x${"0".repeat(63)}7` }, index: 2 };
const statePath = () => join(mkdtempSync(join(tmpdir(), "hydration-holders-")), "holders.json");
const snapshot = ({ rpc, config }: { rpc: Rpc; config: Config }) =>
  takeSnapshot({ rpc, config, block: BLOCK, selection: SELECTION, target: BLOCK.timestamp, holdersPath: statePath() });

test("a snapshot records balances, HOLLAR debt per market and prices for every holder", async () => {
  const s = await snapshot(chain({ holders: [USERS.a, USERS.b, USERS.c] }));
  assert.equal(s.holders, 3);
  assert.equal(s.target, BLOCK.timestamp);
  assert.deepEqual(s.selection, SELECTION);
  assert.equal(s.reserves.HUSDC.price, "102000000");
  assert.equal(s.reserves.HUSDC.holdersSum, s.reserves.HUSDC.totalSupply);
  assert.deepEqual(Object.keys(s.debtAssets), ["HOLLAR"]);
  assert.deepEqual(s.accounts[USERS.a].debt.HOLLAR, {
    main: (30n * E18).toString(),
    gigahdx: (5n * E18).toString(),
    bil: "0",
  });
  assert.equal(s.accounts[USERS.b].debt.HOLLAR.bil, E18.toString());
});

test("a holder missing from the index stops the snapshot", async () => {
  // c holds 7 aHUSDC but never shows up in the logs.
  await assert.rejects(snapshot(chain({ holders: [USERS.a, USERS.b] })), /holder index is missing accounts/);
});

test("a failed read stops the snapshot instead of becoming zero", async () => {
  const failing = chain({
    holders: [USERS.a, USERS.b, USERS.c],
    failBalanceOf: (to, who) => to === DEBT.gigahdx && who === USERS.a,
  });
  await assert.rejects(snapshot(failing), /execution reverted/);
});

test("HOLLAR must be listed on every market", async () => {
  await assert.rejects(
    snapshot(chain({ holders: [USERS.a, USERS.b, USERS.c], hollarOnBil: false })),
    /HOLLAR is not listed on bil/,
  );
});

test("an oracle that does not price in 8 decimals stops the snapshot", async () => {
  await assert.rejects(
    snapshot(chain({ holders: [USERS.a, USERS.b, USERS.c], oracleUnit: 10n ** 18n })),
    /bil: oracle prices in units of 1000000000000000000/,
  );
});

test("an aToken that differs from the config stops the snapshot", async () => {
  const c = chain({ holders: [USERS.a, USERS.b, USERS.c] });
  c.config.supplyAssets.HUSDC.aToken = A(0xbad);
  await assert.rejects(snapshot(c), /config says/);
});

test("the holder index resumes where it stopped and splits a window that times out", async () => {
  const path = statePath();
  const { rpc } = chain({
    logs: [
      { address: AT.HUSDC, block: 3, to: USERS.a },
      { address: AT.HUSDT, block: 25, to: USERS.b },
    ],
  });
  const tokens = [AT.HUSDC, AT.HUSDT];

  const first = await updateHolderIndex({ rpc, path, tokens, fromBlock: 1, toBlock: 20, maxSpan: 8 });
  assert.deepEqual(first.addresses, [USERS.a]);
  assert.equal(first.scannedTo, 20);

  let timeouts = 1;
  const ranges: [number, number][] = [];
  const flaky = {
    async call(method: string, params: unknown[]) {
      const range = rangeOf(params);
      ranges.push(range);
      if (timeouts-- > 0) throw new RpcError(method, { message: "query timeout of 10 seconds exceeded" });
      return rpc.call(method, params);
    },
  };
  const second = await updateHolderIndex({ rpc: flaky, path, tokens, fromBlock: 1, toBlock: 5_000, maxSpan: 2_000 });
  assert.deepEqual(second.addresses, [USERS.a, USERS.b]);
  assert.equal(second.scannedTo, 5_000);
  assert.deepEqual(ranges[0], [21, 2_020]); // resumed after block 20; this window timed out
  const covered = ranges.slice(1).map((r) => r.join("-"));
  assert.ok(covered.includes("21-1020") && covered.includes("1021-2020"), `split halves missing: ${covered}`);
  // Writes go through a temporary file that is renamed away.
  assert.deepEqual(readdirSync(dirname(path)), ["holders.json"]);
});

test("a window at the minimum size is retried when it times out, then stops the scan", async () => {
  const { rpc } = chain({ logs: [{ address: AT.HUSDC, block: 3, to: USERS.a }] });
  const tokens = [AT.HUSDC, AT.HUSDT];
  const flaky = (failures: number) => {
    let calls = 0;
    return {
      get calls() {
        return calls;
      },
      async call(method: string, params: unknown[]) {
        if (calls++ < failures) throw new RpcError(method, { message: "query timeout of 10 seconds exceeded" });
        return rpc.call(method, params);
      },
    };
  };
  const options = {
    path: statePath(),
    tokens,
    fromBlock: 1,
    toBlock: 100,
    maxSpan: 100,
    minSpan: 500,
    retryDelayMs: 0,
  };

  const recovers = flaky(2);
  assert.deepEqual((await updateHolderIndex({ ...options, rpc: recovers })).addresses, [USERS.a]);
  assert.equal(recovers.calls, 3);

  const neverAnswers = flaky(Infinity);
  await assert.rejects(
    updateHolderIndex({ ...options, path: statePath(), rpc: neverAnswers, retries: 2 }),
    /query timeout/,
  );
  assert.equal(neverAnswers.calls, 3); // the first try and two retries
});

test("logs from an unexpected contract are refused", async () => {
  const { rpc } = chain({ logs: [{ address: AT.HUSDC, block: 3, to: USERS.a }] });
  const tampered = {
    async call(method: string, params: unknown[]) {
      const logs = (await rpc.call(method, params)) as { address: string; topics: string[] }[];
      return logs.map((l) => ({ ...l, address: A(0xbeef) }));
    },
  };
  await assert.rejects(
    updateHolderIndex({
      rpc: tampered,
      path: statePath(),
      tokens: [AT.HUSDC, AT.HUSDT],
      fromBlock: 1,
      toBlock: 5,
      maxSpan: 8,
    }),
    /unexpected contract/,
  );
});

test("the tail of the index can be scanned again to pick up a holder the node left out", async () => {
  const path = statePath();
  const tokens = [AT.HUSDC, AT.HUSDT];
  // The first scan ran against a node that did not serve block 18 yet.
  const lagging = chain({ logs: [{ address: AT.HUSDC, block: 3, to: USERS.a }] });
  const first = await updateHolderIndex({ rpc: lagging.rpc, path, tokens, fromBlock: 1, toBlock: 20, maxSpan: 8 });
  assert.deepEqual(first.addresses, [USERS.a]);

  const complete = chain({
    logs: [
      { address: AT.HUSDC, block: 3, to: USERS.a },
      { address: AT.HUSDT, block: 18, to: USERS.b },
    ],
  });
  // Without a rewind the scan has nothing left to do and the holder stays missing.
  assert.deepEqual(
    (await updateHolderIndex({ rpc: complete.rpc, path, tokens, fromBlock: 1, toBlock: 20, maxSpan: 8 })).addresses,
    [USERS.a],
  );
  const again = await updateHolderIndex({
    rpc: complete.rpc,
    path,
    tokens,
    fromBlock: 1,
    toBlock: 20,
    maxSpan: 8,
    rewind: 5,
  });
  assert.deepEqual(again.addresses, [USERS.a, USERS.b]);
  assert.equal(again.scannedTo, 20);
  // A rewind larger than the index starts over from the first block, never before it.
  const all = await updateHolderIndex({
    rpc: complete.rpc,
    path,
    tokens,
    fromBlock: 1,
    toBlock: 20,
    maxSpan: 8,
    rewind: 1_000,
  });
  assert.deepEqual(all.addresses, [USERS.a, USERS.b]);
});

test("one holder-index scan at a time, and a scan that fails still releases the lock", async () => {
  const path = statePath();
  const { rpc } = chain({ logs: [{ address: AT.HUSDC, block: 3, to: USERS.a }] });
  const options = { path, tokens: [AT.HUSDC, AT.HUSDT], fromBlock: 1, toBlock: 20, maxSpan: 8 };

  // Another process is scanning: the runner, while a rescan by hand starts.
  writeFileSync(`${path}.lock`, JSON.stringify({ pid: process.ppid, host: hostname(), token: "runner" }));
  await assert.rejects(updateHolderIndex({ ...options, rpc }), /the holder index is in use by process/);
  assert.equal(existsSync(path), false, "nothing was scanned");
  rmSync(`${path}.lock`);

  const down = {
    async call(): Promise<unknown> {
      throw new Error("node down");
    },
  };
  await assert.rejects(updateHolderIndex({ ...options, rpc: down }), /node down/);
  assert.equal(existsSync(`${path}.lock`), false, "released although the scan failed");
  assert.deepEqual((await updateHolderIndex({ ...options, rpc })).addresses, [USERS.a]);
});

test("snapshotHour stores the hour's snapshot at the block that the hash of the block after the hour picks", async () => {
  const { rpc, config } = chain({ holders: [USERS.a, USERS.b, USERS.c] });
  const hour = 360_000;
  // One block every 6 seconds: block 10 is the first of the hour, block 610 the first after it.
  const block = (n: number) => ({
    number: `0x${n.toString(16)}`,
    hash: `0x${n.toString(16).padStart(64, "0")}`,
    timestamp: `0x${(hour - 60 + 6 * n).toString(16)}`,
  });
  const node: Rpc = {
    batch: rpc.batch,
    async call(method: string, params: unknown[]) {
      if (method === "eth_chainId") return "0x3640e";
      if (method === "eth_getBlockByNumber") {
        const tag = String(params[0]);
        return block(tag === "finalized" ? 700 : Number(BigInt(tag)));
      }
      return rpc.call(method, params);
    },
  };
  const dataDir = mkdtempSync(join(tmpdir(), "hydration-rewards-"));
  const { path, snapshot } = await snapshotHour({ rpc: node, config, dataDir, target: hour });

  assert.equal(path, join(dataDir, "snapshots", `${hour}.json`));
  // 600 candidates, blocks 10 to 609; the seed's hash, 610 here, picks index 10: block 20.
  assert.deepEqual(snapshot.selection, {
    firstBlock: 10,
    blocks: 600,
    seed: { number: 610, hash: `0x${(610).toString(16).padStart(64, "0")}` },
    index: 10,
  });
  assert.equal(snapshot.block.number, 20);
  assert.equal(snapshot.target, hour);
  assert.equal(snapshot.holders, 3);
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), snapshot);
  assert.doesNotThrow(() => checkSelection(snapshot.selection, snapshot.block.number, path)); // what the closer checks
});
