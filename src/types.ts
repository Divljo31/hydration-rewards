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
  chainId?: number;
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

// data/snapshots/<hour>.json
export interface Snapshot {
  format: string;
  target: number;
  block: Block;
  markets: Record<string, { pool: string; oracle: string }>;
  reserves: Record<string, SnapshotReserve>;
  debtAssets: Record<string, SnapshotDebtAsset>;
  holders: number;
  accounts: Record<string, SnapshotAccount>;
}

// programs/*.yaml after checking. Budgets and the start hour are null while undecided.
export interface Program {
  name: string;
  earn: string[];
  budgetPerDay: Map<string, bigint | null>;
  startHourUtc: number | null;
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
