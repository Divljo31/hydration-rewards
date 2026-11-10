// Epoch amounts + previous cumulative tree -> new cumulative Merkle tree for Morpho's
// Universal Rewards Distributor (URD) at 3de504b.
//
// The URD checks  keccak256(bytes.concat(keccak256(abi.encode(account, reward, claimable))))
// against its root, which is OpenZeppelin's StandardMerkleTree with leaf encoding
// (address, address, uint256). `claimable` is cumulative: a claim pays
// claimable - claimed[account][reward], so every account from earlier epochs must stay in
// the tree and no amount may ever go down. That is why the previous tree must be the one for
// the day before: building on an older tree silently drops the days in between.

import { StandardMerkleTree } from "@openzeppelin/merkle-tree";
import { compareAddresses, normalizeAddress } from "./lib/accounts.ts";
import { addDays, epochDayStart } from "./lib/epoch.ts";
import type { EpochWindow, Tree } from "./types.ts";

const TREE_FORMAT = "hydration-rewards-tree/1";
export const LEAF_ENCODING = ["address", "address", "uint256"];

function sortedByAccount(map: Map<string, bigint>): Map<string, bigint> {
  return new Map([...map.entries()].sort(([a], [b]) => compareAddresses(a, b)));
}

function merkleTree(reward: string, cumulative: Map<string, bigint>) {
  const values = [...cumulative.entries()].map(([account, amount]): string[] => [account, reward, amount.toString()]);
  if (values.length === 0) throw new Error("the tree would have no accounts");
  return StandardMerkleTree.of(values, LEAF_ENCODING);
}

const sum = (amounts: Iterable<bigint>): bigint => [...amounts].reduce((a, b) => a + b, 0n);

// Reads a tree this tool wrote earlier and proves it is intact by rebuilding its root.
function readTree(tree: Tree, reward: string): Map<string, bigint> {
  if (tree?.format !== TREE_FORMAT) throw new Error(`not a ${TREE_FORMAT} file`);
  epochDayStart(tree.epoch);
  if (normalizeAddress(tree.reward) !== reward) {
    throw new Error(`previous tree pays ${tree.reward}, this epoch pays ${reward}`);
  }
  const cumulative = new Map<string, bigint>();
  for (const [account, claim] of Object.entries(tree.claims)) {
    if (!/^\d+$/.test(claim.claimable)) throw new Error(`bad claimable for ${account}`);
    cumulative.set(normalizeAddress(account), BigInt(claim.claimable));
  }
  const rebuilt = merkleTree(reward, sortedByAccount(cumulative)).root;
  if (rebuilt !== tree.root) {
    throw new Error(`previous tree is inconsistent: file root ${tree.root}, claims rebuild to ${rebuilt}`);
  }
  return cumulative;
}

// window: the { start, end } unix seconds this epoch's snapshots cover. It is stored in the tree
// so the next epoch can prove it starts where this one ended.
// allowGap: accept a previous tree that does not end where this epoch starts. Only for a day that
// can never be closed (no snapshots exist); the gap is visible in the tree as previousEpoch.
export function buildTree({
  epoch,
  window,
  reward,
  epochAmounts,
  previous = null,
  genesis = false,
  allowGap = false,
}: {
  epoch: string;
  window: EpochWindow;
  reward: string;
  epochAmounts: Map<string, bigint>;
  previous?: Tree | null;
  genesis?: boolean;
  allowGap?: boolean;
}): Tree {
  epochDayStart(epoch);
  if (!Number.isInteger(window?.start) || !Number.isInteger(window?.end) || window.end <= window.start) {
    throw new Error(`the epoch's window is required, got ${JSON.stringify(window)}`);
  }
  reward = normalizeAddress(reward);
  let before = new Map<string, bigint>();
  if (previous) {
    if (genesis) throw new Error("pass a previous tree or genesis, not both");
    before = readTree(previous, reward);
    if (!(previous.epoch < epoch)) {
      throw new Error(`previous tree is for ${previous.epoch}, which is not before ${epoch}`);
    }
    const dayBefore = addDays(epoch, -1);
    if (previous.epoch !== dayBefore && !allowGap) {
      throw new Error(
        `previous tree is for ${previous.epoch}, but the epoch before ${epoch} is ${dayBefore}; ` +
          "building on an older tree drops the rewards of the days in between",
      );
    }
    // A changed start hour would count some hours in both epochs, or in neither.
    if (previous.window?.end !== window.start && !allowGap) {
      throw new Error(
        `previous tree's epoch ended at ${previous.window?.end}, but ${epoch} starts at ${window.start}; ` +
          "the epochs must follow each other without a gap or an overlap",
      );
    }
  } else if (!genesis) {
    throw new Error("a previous tree is required; only the first epoch may use genesis");
  }

  const cumulative = new Map(before);
  for (const [rawAccount, amount] of epochAmounts) {
    const account = normalizeAddress(rawAccount);
    if (typeof amount !== "bigint" || amount < 0n) throw new Error(`bad amount for ${account}`);
    if (amount === 0n) continue;
    cumulative.set(account, (cumulative.get(account) ?? 0n) + amount);
  }
  for (const [account, previousAmount] of before) {
    const now = cumulative.get(account);
    if (now === undefined || now < previousAmount) throw new Error(`cumulative amount fell for ${account}`);
  }

  const ordered = sortedByAccount(cumulative);
  const tree = merkleTree(reward, ordered);
  const proofs = new Map<string, string[]>();
  for (const [index, [account]] of tree.entries()) proofs.set(account, tree.getProof(index));

  const claims: Tree["claims"] = {};
  for (const [account, amount] of ordered) {
    const proof = proofs.get(account);
    if (!proof || !StandardMerkleTree.verify(tree.root, LEAF_ENCODING, [account, reward, amount.toString()], proof)) {
      throw new Error(`proof does not verify for ${account}`);
    }
    claims[account] = { claimable: amount.toString(), proof };
  }

  return {
    format: TREE_FORMAT,
    epoch,
    window: { start: window.start, end: window.end },
    previousEpoch: previous ? previous.epoch : null,
    previousRoot: previous ? previous.root : null,
    reward,
    leafEncoding: LEAF_ENCODING,
    root: tree.root,
    totals: {
      epoch: sum(epochAmounts.values()).toString(),
      previous: sum(before.values()).toString(),
      cumulative: sum(ordered.values()).toString(),
    },
    accounts: ordered.size,
    claims,
  };
}
