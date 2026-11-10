// The handful of calls the snapshotter makes, hand-encoded. Selectors were generated with `cast sig`.
import { toBlockTag } from "./rpc.ts";
import type { RpcRequest } from "../types.ts";

export const SELECTORS = {
  getPool: "0x026b1d5f", // PoolAddressesProvider.getPool()
  getPriceOracle: "0xfca513a8", // PoolAddressesProvider.getPriceOracle()
  getReserveData: "0x35ea6a75", // Pool.getReserveData(address)
  getAssetPrice: "0xb3596f07", // AaveOracle.getAssetPrice(address)
  baseCurrencyUnit: "0x8c89b64f", // AaveOracle.BASE_CURRENCY_UNIT()
  balanceOf: "0x70a08231",
  totalSupply: "0x18160ddd",
  decimals: "0x313ce567",
};

export const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

const word = (address: string): string => address.toLowerCase().replace(/^0x/, "").padStart(64, "0");

export function ethCall(to: string, selector: string, args: string[], block: number): RpcRequest {
  return { method: "eth_call", params: [{ to, data: selector + args.map(word).join("") }, toBlockTag(block)] };
}

function words(hex: unknown, count: number, what: string): string[] {
  if (typeof hex !== "string" || !/^0x[0-9a-f]*$/i.test(hex) || hex.length < 2 + 64 * count) {
    throw new Error(`${what}: expected ${count} words, got ${hex}`);
  }
  return Array.from({ length: count }, (_, i) => hex.slice(2 + 64 * i, 2 + 64 * (i + 1)));
}

export const decodeUint = (hex: unknown, what: string): bigint => BigInt(`0x${words(hex, 1, what)[0]}`);

export const decodeAddress = (hex: unknown, what: string): string => `0x${words(hex, 1, what)[0].slice(24)}`;

// Pool.getReserveData returns a 15-word static struct; the aToken is word 8 and the variable debt
// token word 10. (Word 9 is the stable debt token; stable borrowing is not enabled on Hydration.)
export function decodeReserveData(hex: unknown, what: string): { aToken: string; variableDebtToken: string } {
  const w = words(hex, 15, what);
  const addr = (i: number): string => `0x${w[i].slice(24)}`;
  return { aToken: addr(8), variableDebtToken: addr(10) };
}
