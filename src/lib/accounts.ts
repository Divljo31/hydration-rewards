// Accounts are 20-byte EVM addresses: the address that holds aTokens and receives URD payouts.
//
// A Substrate account appears in the EVM as its first 20 bytes, and a payout to that address
// reaches the Substrate account only if it has bound its EVM address (evm-accounts pallet).
// Converting a 32-byte account id here would pay unbound accounts into an address nobody
// controls, so 32-byte ids are refused instead of truncated.

export function normalizeAddress(input: unknown): string {
  if (typeof input !== "string") throw new TypeError(`account must be a hex string, got ${typeof input}`);
  const hex = input.trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(hex)) throw new Error(`expected a 20-byte 0x address: ${input}`);
  return hex;
}

// Substrate pallet accounts (and their sub-accounts) start with "modl" + an 8-byte PalletId,
// e.g. the Treasury `modlpy/trsry` -> 0x6d6f646c70792f74727372790000000000000000.
const PALLET_PREFIX = "0x6d6f646c";

export function isPalletAccount(address: string): boolean {
  return normalizeAddress(address).startsWith(PALLET_PREFIX);
}

export function palletIdOf(address: string): string | null {
  const a = normalizeAddress(address);
  if (!a.startsWith(PALLET_PREFIX)) return null;
  const bytes = Buffer.from(a.slice(10, 26), "hex");
  return bytes.toString("latin1").replace(/[^\x20-\x7e]/g, ".");
}

export function compareAddresses(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
