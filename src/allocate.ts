// Budget per reserve + eligible sums -> integer reward per account.
//
// reward_a = floor( Σ_r budget_r × e_{a,r} / E_r )
// computed over one common denominator, so each account is rounded down once and the dust is
// smaller than the number of earning accounts (those with any eligible value, including the ones
// whose share rounds down to nothing). Paid accounts are those that receive at least one unit.
// A reserve nobody is eligible for is left undistributed and reported; what happens to that budget
// is a decision for the operators.

import type { PerAccount } from "./types.ts";

// A value that must be there: a missing budget or total is an error, never a zero.
function need(map: Map<string, bigint>, name: string): bigint {
  const value = map.get(name);
  if (value === undefined) throw new Error(`no value for ${name}`);
  return value;
}

export function allocate({
  eligible,
  totals,
  budgets,
}: {
  eligible: PerAccount;
  totals: Map<string, bigint>;
  budgets: Map<string, bigint>;
}) {
  for (const name of totals.keys()) {
    if (!budgets.has(name)) throw new Error(`no budget given for ${name}`);
  }
  for (const [name, budget] of budgets) {
    if (!totals.has(name)) throw new Error(`budget given for ${name}, which the snapshots do not contain`);
    if (typeof budget !== "bigint" || budget < 0n) throw new Error(`bad budget for ${name}`);
  }

  const live = [...totals.entries()].filter(([name, total]) => total > 0n && need(budgets, name) > 0n).map(([n]) => n);
  const undistributed = new Map<string, bigint>();
  for (const name of totals.keys()) {
    if (!live.includes(name)) undistributed.set(name, need(budgets, name));
  }

  const denominator = live.reduce((acc, name) => acc * need(totals, name), 1n);
  const crossTerm = new Map(
    live.map((name): [string, bigint] => [
      name,
      live.filter((q) => q !== name).reduce((acc, q) => acc * need(totals, q), 1n),
    ]),
  );

  const amounts = new Map<string, bigint>();
  let earningAccounts = 0n;
  let distributed = 0n;
  for (const [account, perReserve] of eligible) {
    let numerator = 0n;
    for (const name of live) {
      numerator += need(budgets, name) * (perReserve.get(name) ?? 0n) * need(crossTerm, name);
    }
    if (numerator === 0n) continue;
    const reward = numerator / denominator;
    earningAccounts += 1n;
    distributed += reward;
    if (reward > 0n) amounts.set(account, reward);
  }

  const liveBudget = live.reduce((acc, name) => acc + need(budgets, name), 0n);
  const dust = liveBudget - distributed;
  if (dust < 0n || (earningAccounts > 0n ? dust >= earningAccounts : dust !== liveBudget)) {
    throw new Error(
      `allocation out of bounds: budget ${liveBudget}, distributed ${distributed}, accounts ${earningAccounts}`,
    );
  }
  return { amounts, distributed, dust, undistributed, earningAccounts, paidAccounts: amounts.size };
}
