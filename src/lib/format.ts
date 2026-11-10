// Values are exact integers in units of 1e-26 USD: token units scaled to 18 decimals times
// AaveOracle prices with 8 decimals.
export const VALUE_UNIT = 10n ** 26n;

// "1234.56", rounded down to the cent. Exact, for summaries.
export function usdExact(value: bigint): string {
  const cents = (value * 100n) / VALUE_UNIT;
  return `${cents / 100n}.${String(cents % 100n).padStart(2, "0")}`;
}

// Dollars as a number, for ratios and display only.
export const usdNumber = (value: bigint): number => Number((value * 100n) / VALUE_UNIT) / 100;

// "$1,235", for people.
export const usdRounded = (value: bigint): string =>
  `$${usdNumber(value).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
