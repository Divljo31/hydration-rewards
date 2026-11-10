// Accounts that earn nothing: Treasury, pallet pots, ICE pot, stableswap pool accounts.
//
// config/denylist.json:
//   rules.palletAccounts  deny every address that starts with "modl" (Substrate pallet accounts and
//                         their sub-accounts, which is how the Treasury and the pots appear in the EVM)
//   addresses             explicit entries, each with a label saying what it is
//   unresolved            entries a human still has to supply; while any remain the list is provisional

import { readFileSync } from "node:fs";
import { isPalletAccount, normalizeAddress, palletIdOf } from "./accounts.ts";
import { sha256 } from "./io.ts";
import type { Denylist } from "../types.ts";

// config/denylist.json
export interface DenylistFile {
  note?: string;
  rules?: { palletAccounts?: boolean };
  addresses?: { address: string; label: string }[];
  unresolved?: string[];
}

export function makeDenylist(config: DenylistFile, source = "denylist"): Denylist {
  const explicit = new Map<string, string>();
  for (const entry of config.addresses ?? []) {
    if (!entry.label) throw new Error(`${source}: every address needs a label`);
    explicit.set(normalizeAddress(entry.address), entry.label);
  }
  const palletRule = config.rules?.palletAccounts === true;
  const unresolved = config.unresolved ?? [];
  return {
    provisional: unresolved.length > 0,
    unresolved,
    reasonFor(address) {
      const a = normalizeAddress(address);
      const label = explicit.get(a);
      if (label !== undefined) return label;
      if (palletRule && isPalletAccount(a)) return `pallet account ${palletIdOf(a)}`;
      return null;
    },
  };
}

export function loadDenylist(path: string): Denylist & { sha256: string } {
  const text = readFileSync(path, "utf8");
  const list = makeDenylist(JSON.parse(text), path);
  return { ...list, sha256: sha256(text) };
}
