// The shapes that travel between the commands: chain config, snapshots, programs and trees.
// Types describe what the code expects; files read from disk are still checked at run time.

export interface RewardConfig {
  symbol: string;
  assetId: number;
  address: string;
  decimals: number;
}

export interface SupplyAssetConfig {
  assetId?: number;
  market: string;
  underlying: string;
  aToken: string;
  deployBlock: number;
}

export interface DebtAssetConfig {
  underlying: string;
  decimals: number;
}

// config/mainnet.json
export interface Config {
  network?: string;
  // checked against the node's eth_chainId before every snapshot
  chainId: number;
  rpc: string;
  rpcBatchSize?: number;
  reward: RewardConfig;
  epoch: { snapshotsPerEpoch: number };
  markets: Record<string, { poolAddressesProvider: string }>;
  supplyAssets: Record<string, SupplyAssetConfig>;
  debtAssets: Record<string, DebtAssetConfig>;
  logs: { maxBlockSpan: number; concurrency?: number };
}

export interface Block {
  number: number;
  hash: string;
  timestamp: number;
}

export interface SnapshotReserve {
  aToken: string;
  underlying: string;
  market: string;
  decimals: number;
  price: string;
  totalSupply: string;
  holdersSum: string;
}

export interface SnapshotDebtAsset {
  decimals: number;
  markets: Record<string, { debtToken: string; price: string }>;
}

export interface SnapshotAccount {
  supply: Record<string, string>;
  // asset -> market -> raw debt
  debt: Record<string, Record<string, string>>;
}

// How a snapshot's block was picked inside its hour (src/lib/selection.ts): blocks firstBlock to
// firstBlock + blocks - 1 fall inside the hour, seed is the first block after it, and the snapshot's
// block is firstBlock + index, where index = seed hash mod blocks.
export interface SnapshotSelection {
  firstBlock: number;
  blocks: number;
  seed: { number: number; hash: string };
  index: number;
}

// data/snapshots/<hour>.json
export interface Snapshot {
  format: string;
  target: number;
  block: Block;
  selection: SnapshotSelection;
  markets: Record<string, { pool: string; oracle: string }>;
  reserves: Record<string, SnapshotReserve>;
  debtAssets: Record<string, SnapshotDebtAsset>;
  holders: number;
  accounts: Record<string, SnapshotAccount>;
}

// programs/*.yaml after checking. Budgets, the start hour and the first epoch are null while undecided.
export interface Program {
  name: string;
  earn: string[];
  budgetPerDay: Map<string, bigint | null>;
  startHourUtc: number | null;
  // the first epoch this file pays (applies_from_epoch); a close of any other epoch checks it
  appliesFromEpoch: string | null;
  maxHollarDebt: bigint;
  sha256: string;
}

export interface EpochWindow {
  start: number;
  end: number;
}

export interface Claim {
  claimable: string;
  proof: string[];
}

// data/trees/<epoch>.json
export interface Tree {
  format: string;
  epoch: string;
  window: EpochWindow;
  previousEpoch: string | null;
  previousRoot: string | null;
  reward: string;
  leafEncoding: string[];
  root: string;
  totals: { epoch: string; previous: string; cumulative: string };
  accounts: number;
  claims: Record<string, Claim>;
}

export interface Denylist {
  provisional: boolean;
  unresolved: string[];
  reasonFor(address: string): string | null;
}

// config/denylist.json as read from disk, with the hash every epoch summary records.
export type LoadedDenylist = Denylist & { sha256: string };

export interface RpcRequest {
  method: string;
  params: unknown[];
}

// Results are untyped on purpose: every caller decodes and checks what it gets back.
export interface Rpc {
  call(method: string, params: unknown[]): Promise<unknown>;
  batch(requests: RpcRequest[]): Promise<unknown[]>;
}

export type Log = (line: string) => void;

// account -> asset -> value
export type PerAccount = Map<string, Map<string, bigint>>;

// data/public/trees/<root>.json: everything needed to claim against one root, and nothing that
// depends on which epoch produced it (two epochs can end on the same root).
export interface ClaimsFile {
  format: string;
  reward: string;
  root: string;
  leafEncoding: string[];
  claims: Record<string, Claim>;
}

// One account in data/public/latest.json.
export interface AccountStatus {
  earning: boolean;
  // why not, when it is not earning
  reason?: "hollar_debt" | "excluded";
  // HOLLAR debt on all markets, in dollars; left out for excluded accounts
  hollarDebtUsd?: string;
}

// data/public/latest.json: who is earning as of the most recent snapshot, and what the app needs
// to show a rate. Amounts are strings; reward amounts are raw units, dollars have two decimals.
export interface LatestFile {
  format: string;
  asOf: { hour: number; block: number; blockTime: number };
  reward: { symbol: string; address: string; decimals: number };
  program: { name: string; sha256: string; maxHollarDebtUsd: string };
  // per earning asset: the daily budget (null while undecided) and the value it is shared over
  assets: Record<string, { budgetPerDay: string | null; eligibleUsd: string }>;
  // every account that supplied an earning asset at the snapshot
  accounts: Record<string, AccountStatus>;
  // the newest closed epoch; its tree is trees/<root>.json. The root may not be on chain yet.
  latestTree: { epoch: string; root: string } | null;
}
