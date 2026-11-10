#!/usr/bin/env node
// Writes the trees the real builder makes from two sample epochs, in the shape the Foundry tests read.
// Every address is synthetic. The reward is PRIME's ERC-20 precompile address; the tests etch a
// mock token there so the leaves match what mainnet claims will use.

import { fileURLToPath } from "node:url";
import { buildTree } from "../src/build-tree.ts";
import { toJson, writeText } from "../src/lib/io.ts";
import type { EpochWindow, Tree } from "../src/types.ts";

export const PRIME = "0x000000000000000000000000000000010000002b";

export const ACCOUNTS = {
  alice: "0x00000000000000000000000000000000000a11ce",
  bob: "0x0000000000000000000000000000000000000b0b",
  carol: `0x${"c0".repeat(20)}`,
  dave: `0x${"d0".repeat(20)}`,
};

export const EPOCH_1 = new Map([
  [ACCOUNTS.alice, 1_000_000_000n],
  [ACCOUNTS.bob, 250_500_000n],
  [ACCOUNTS.carol, 3_141_592n],
]);

// Bob and Carol earn nothing in epoch 2 and must still be able to claim epoch 1.
export const EPOCH_2 = new Map([
  [ACCOUNTS.alice, 500_000_000n],
  [ACCOUNTS.dave, 42_000_000n],
]);

// Daily windows starting at 14:00 UTC.
export function windowOf(epoch: string): EpochWindow {
  const start = Date.parse(`${epoch}T14:00:00Z`) / 1000;
  return { start, end: start + 86_400 };
}

// The Foundry tests read arrays, which Solidity's JSON cheatcodes handle more reliably than maps.
function forgeView(tree: Tree) {
  const accounts = Object.keys(tree.claims);
  return {
    root: tree.root,
    reward: tree.reward,
    accounts,
    claimables: accounts.map((a) => tree.claims[a].claimable),
    proofs: accounts.map((a) => tree.claims[a].proof),
  };
}

export function makeFixtures() {
  const tree1 = buildTree({
    epoch: "2026-11-11",
    window: windowOf("2026-11-11"),
    reward: PRIME,
    epochAmounts: EPOCH_1,
    genesis: true,
  });
  const tree2 = buildTree({
    epoch: "2026-11-12",
    window: windowOf("2026-11-12"),
    reward: PRIME,
    epochAmounts: EPOCH_2,
    previous: tree1,
  });
  return { tree1, tree2 };
}

function main() {
  const dir = fileURLToPath(new URL("../contracts/test/fixtures/", import.meta.url));
  const { tree1, tree2 } = makeFixtures();
  writeText(`${dir}forge-2026-11-11.json`, toJson(forgeView(tree1)));
  writeText(`${dir}forge-2026-11-12.json`, toJson(forgeView(tree2)));
  console.log(`epoch 1 root ${tree1.root}\nepoch 2 root ${tree2.root}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
