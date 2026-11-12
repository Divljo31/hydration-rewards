import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeAddress, decodeReserveData, decodeUint, ethCall, SELECTORS } from "../src/lib/abi.ts";
import { checkSelection } from "../src/lib/selection.ts";
import { blockAtOrAfter, checkChainId, parseTime, snapshotBlock, snapshotHour } from "../src/snapshot.ts";
import type { Config } from "../src/types.ts";

const CHAIN_ID = "0x3640e"; // 222222, Hydration

test("calls are encoded with the selector and a padded address", () => {
  const call = ethCall("0xToken", SELECTORS.balanceOf, ["0x00000000000000000000000000000000000A11CE"], 16843184);
  assert.equal(call.method, "eth_call");
  assert.equal((call.params[0] as { data: string }).data, `0x70a08231${"0".repeat(59)}a11ce`);
  assert.equal(call.params[1], "0x10101b0"); // block 16,843,184
});

test("return data is decoded strictly", () => {
  assert.equal(decodeUint(`0x${"0".repeat(63)}7`, "x"), 7n);
  assert.equal(decodeAddress(`0x${"0".repeat(24)}${"ab".repeat(20)}`, "x"), `0x${"ab".repeat(20)}`);
  assert.throws(() => decodeUint("0x", "balanceOf"), /expected 1 words/);

  // Main-market HOLLAR reserve data as returned at block 16,843,184 (token words only matter here).
  const word = (hex: string) => hex.replace(/^0x/, "").padStart(64, "0");
  const data = `0x${[
    ...Array(8).fill(word("0")),
    word("0x8c0f3b9602374198974d2b2679d14a386f5b108e"),
    word("0xd95d27688f028addbe93fa0e19fb095ee1111dd1"),
    word("0x342923782ccaebf9c38dd9cb40436e82c42c73b5"),
    ...Array(4).fill(word("0")),
  ].join("")}`;
  assert.deepEqual(decodeReserveData(data, "HOLLAR"), {
    aToken: "0x8c0f3b9602374198974d2b2679d14a386f5b108e",
    variableDebtToken: "0x342923782ccaebf9c38dd9cb40436e82c42c73b5",
  });
  assert.throws(() => decodeReserveData("0x00", "HOLLAR"), /expected 15 words/);
});

// A chain with one block every 6 seconds from t=1000; `finalized` trails `latest`.
function chain({ finalized, latest }: { finalized: number; latest: number }) {
  const block = (n: number) => ({
    number: `0x${n.toString(16)}`,
    hash: `0x${n.toString(16).padStart(64, "0")}`,
    timestamp: `0x${(1000 + 6 * n).toString(16)}`,
  });
  const asked: string[] = [];
  return {
    asked,
    async call(method: string, params: unknown[]) {
      const tag = String(params[0]);
      assert.equal(method, "eth_getBlockByNumber");
      asked.push(tag);
      if (tag === "finalized") return block(finalized);
      if (tag === "latest") return block(latest);
      const n = Number(BigInt(tag));
      return n <= latest ? block(n) : null;
    },
  };
}

test("the first block at or after a time is found by its timestamp", async () => {
  const rpc = chain({ finalized: 500, latest: 520 });
  assert.deepEqual(await blockAtOrAfter(rpc, 1000 + 6 * 100), {
    number: 100,
    hash: `0x${(100).toString(16).padStart(64, "0")}`,
    timestamp: 1600,
  });
  assert.equal((await blockAtOrAfter(rpc, 1601)).number, 101); // between two blocks: the later one
  assert.equal((await blockAtOrAfter(rpc, 1)).number, 1);
});

test("a snapshot waits for the block to be finalized", async () => {
  // Block 510 is at or after the target and already produced, but the finalized head is still at 500.
  const rpc = chain({ finalized: 500, latest: 520 });
  await assert.rejects(blockAtOrAfter(rpc, 1000 + 6 * 510), /no finalized block at or after/);
  assert.ok(!rpc.asked.includes("latest"));
});

test("the snapshot block is one of the hour's own, picked by the hash of the first block after the hour", async () => {
  // The hour from t=3600: blocks 434 (t=3604) to 1033 fall inside it, block 1034 (t=7204) is the first
  // after it. That block's hash, 1034 in this chain, picks index 1034 mod 600 = 434: block 868.
  const { block, selection } = await snapshotBlock(chain({ finalized: 1_100, latest: 1_200 }), 3600, 3600);
  assert.deepEqual(selection, {
    firstBlock: 434,
    blocks: 600,
    seed: { number: 1_034, hash: `0x${(1_034).toString(16).padStart(64, "0")}` },
    index: 434,
  });
  assert.equal(block.number, 868);
  assert.ok(block.timestamp >= 3600 && block.timestamp < 7200);
  assert.doesNotThrow(() => checkSelection(selection, block.number, "picked")); // what the closer checks

  // Until the block after the hour is finalized, the hour cannot be taken: nobody knows its hash yet.
  await assert.rejects(snapshotBlock(chain({ finalized: 1_000, latest: 1_200 }), 3600, 3600), (error: any) => {
    return error.code === "NOT_FINALIZED" && /at or after 7200/.test(error.message);
  });
});

test("an hour with no block in it is refused, not stored under that hour", async () => {
  // Blocks every 6 seconds from t=1000, so with one-hour slots from t=0 the first block at or
  // after 3600 is inside its hour, but a "chain" whose blocks are 2 hours apart has none.
  // Only the epoch settings and the chain id are read before the block is checked.
  const config = { chainId: 222222, epoch: { snapshotsPerEpoch: 24 } } as Config;
  const stalled = {
    async batch(): Promise<unknown[]> {
      throw new Error("not reached: the hour is refused before any balance is read");
    },
    async call(method: string, params: unknown[]) {
      if (method === "eth_chainId") return CHAIN_ID;
      const tag = String(params[0]);
      const n = tag === "finalized" ? 5 : Number(BigInt(tag));
      return { number: `0x${n.toString(16)}`, hash: "0x00", timestamp: `0x${(n * 7200 + 60).toString(16)}` };
    },
  };
  // Target 3600: the first block at or after it is block 1 at t=7260, in a later hour.
  await assert.rejects(
    snapshotHour({ rpc: stalled, config, dataDir: "/nonexistent", target: 3600 }),
    (error: any) => error.code === "NO_BLOCK_IN_HOUR" && /no block between 3600 and 7200/.test(error.message),
  );
  await assert.rejects(snapshotHour({ rpc: stalled, config, dataDir: "/nonexistent", target: 3601 }), /on the hour/);
});

test("a node that serves another chain is refused before anything is read", async () => {
  const config = { chainId: 222222, epoch: { snapshotsPerEpoch: 24 } } as Config;
  const other = {
    async batch(): Promise<unknown[]> {
      throw new Error("not reached");
    },
    async call(method: string) {
      if (method === "eth_chainId") return "0x1";
      throw new Error(`not reached: ${method} before the chain id is checked`);
    },
  };
  await assert.rejects(
    snapshotHour({ rpc: other, config, dataDir: "/nonexistent", target: 3600 }),
    /serves chain 1, but the config is for chain 222222/,
  );
  await assert.rejects(checkChainId({ call: async () => 42 }, config), /serves chain 42/);
  await assert.doesNotReject(checkChainId({ call: async () => CHAIN_ID }, config));
});

test("--at needs its time zone, so a snapshot is never quietly of another hour", () => {
  assert.equal(parseTime("1800021600"), 1_800_021_600); // 15 Jan 2027 14:00 UTC
  assert.equal(parseTime("2027-01-15T14:00:00Z"), 1_800_021_600);
  assert.equal(parseTime("2027-01-15T15:00:00+01:00"), 1_800_021_600);
  // Read in this machine's zone, this would be 14:00 UTC in Belgrade and 09:30 UTC in Kolkata.
  assert.throws(() => parseTime("2027-01-15T15:00:00"), /unix seconds or a time with its zone/);
  assert.throws(() => parseTime("2027-01-15"), /unix seconds or a time with its zone/);
});
