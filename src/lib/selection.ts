// Which block of its hour a snapshot is taken at.
//
// Every block whose timestamp falls inside the hour is a candidate, and the hash of the first block
// after the hour picks one: index = hash mod (number of candidates). That hash does not exist until
// the hour is over, so nobody can time a deposit, a withdrawal or a HOLLAR repayment around the
// snapshot; holding a position for part of the hour earns that part of it on average. The author of
// the seed block could bias which of the hour's blocks is picked, and nothing more.
//
// The snapshotter applies the rule (src/snapshot.ts); the closer checks that every snapshot of an
// epoch followed it, from the numbers the snapshot records.

import type { SnapshotSelection } from "../types.ts";

const HASH = /^0x[0-9a-fA-F]{64}$/;

export function pickIndex(seedHash: string, blocks: number): number {
  if (!HASH.test(seedHash)) throw new Error(`a block hash is 32 bytes of hex, got ${seedHash}`);
  if (!Number.isSafeInteger(blocks) || blocks < 1) throw new Error(`an hour has at least one block, got ${blocks}`);
  return Number(BigInt(seedHash) % BigInt(blocks));
}

// Throws unless `blockNumber` is the block `selection` picks by the rule above.
export function checkSelection(selection: SnapshotSelection | null | undefined, blockNumber: number, where: string) {
  const s = selection;
  const followsRule =
    s != null &&
    Number.isSafeInteger(s.firstBlock) &&
    Number.isSafeInteger(s.blocks) &&
    s.blocks >= 1 &&
    s.seed?.number === s.firstBlock + s.blocks &&
    typeof s.seed.hash === "string" &&
    HASH.test(s.seed.hash) &&
    s.index === pickIndex(s.seed.hash, s.blocks) &&
    blockNumber === s.firstBlock + s.index;
  if (!followsRule) throw new Error(`${where}: its block is not the one its hour's seed block picks`);
}
