---
name: reward-program
description: Change the PRIME reward program for Hydration from a plain-language description, check its effect on real snapshots, and open a pull request for review. Use this whenever someone wants to change who earns PRIME on HUSDC/HUSDT/HEURC, how strictly HOLLAR borrowers are excluded, a daily budget, the epoch start hour, which H-tokens earn, or asks "what would happen if…" about these incentives — even if they never mention YAML, programs/ or the preview script.
---

# The reward program

The person you are helping is usually not a developer. They know what behaviour they want to
reward; your job is to turn that into the program file, show them what it does with real numbers,
and hand it to a developer for review. Speak in their terms (accounts, dollars, PRIME per day),
not in file formats or code.

Everything here runs from the repository root.

## What the program file is

The program lives in `programs/htoken-no-hollar-borrowers.yaml`. `programs/README.md` is the
reference for every setting; read it before writing anything. Epochs are only closed with a file
that has been merged after review, and every epoch records the exact file it used, so a mistake
you make here does not pay anyone unless a developer approves it. That is why the rest of this
skill is about being accurate and explaining clearly, not about speed.

## Only use what exists

The program reader stops on anything it does not recognise, so inventing a setting just produces
an error. The whole strategy is fixed: accounts earn on their HUSDC, HUSDT and HEURC supply unless
they have borrowed HOLLAR. What can be changed is:

- `applies_from_epoch` — the first daily epoch the settings pay (a UTC date); every change moves it
- `budget_per_day` — PRIME per day for each earning asset
- `epoch_start_hour_utc` — the hour each daily epoch starts
- `earn_on_supply_of` — any of `HUSDC`, `HUSDT` and `HEURC`; each one listed needs its own line
  in `budget_per_day`
- `max_hollar_debt_usd` — an account with more HOLLAR debt than this (added up over main,
  GIGAHDX and BIL) earns nothing for that hour; `0` means any debt disqualifies

When the request needs something else — reducing a borrower's reward instead of removing it,
counting other debt, a minimum position, a cap per account, a holding period, a boost for
stakers, a different reward token, another earning asset — say plainly that it is not available
and needs a developer to build a new strategy, offer the closest thing that does exist, and let
them choose. Do not edit `config/`, the denylist, code or contracts; those changes need a
developer and a different review.

## Decisions are theirs

`budget_per_day` and `epoch_start_hour_utc` set real money and timing. Fill them in only with
numbers the person gives you in this conversation; otherwise leave them blank (the preview still
works, and closing an epoch will refuse until they are set). If they ask what a sensible budget is,
show them the preview's PRIME-per-$1,000 figures for one or two budgets they name rather than
picking one yourself. Never blank or remove `max_hollar_debt_usd`; the reader refuses that.
Once epochs are being closed, do not change `epoch_start_hour_utc`: each epoch must start where
the previous one ended, so the next close would be refused. Say that it needs a developer.

`applies_from_epoch` is theirs to decide too: ask from which day the change should apply. Every
edit to the file, even a small one, needs a new `applies_from_epoch` on an epoch that has not been
closed yet, normally the day after the pull request will be merged or later; otherwise closing
the next epoch is refused. If they do not give a date, leave it blank and say that a developer
will fill it in before merging. Put the date in the pull request's description.

Two consequences are worth raising whenever they apply, because they are easy to miss:

- With a fixed budget, every dollar the HOLLAR rule removes raises the reward rate for everyone
  left. Removing borrowers who hold half the supply roughly doubles what the others earn per dollar.
- The rule is all or nothing: one dollar over the allowance costs an account its whole reward for
  that hour. `max_hollar_debt_usd: 0` disqualifies an account over a few cents of leftover debt.

## Steps

1. Restate the request in one or two sentences of plain language and confirm anything ambiguous
   (which assets earn, how much HOLLAR debt is tolerated, the budget).
2. Keep a copy of the current program so you can compare, then edit the file. The copy can live
   anywhere:
   ```sh
   before="${TMPDIR:-/tmp}/reward-program-before.yaml"
   cp programs/htoken-no-hollar-borrowers.yaml "$before"
   ```
   Keep `name` a readable description.
3. Preview the edited file and the copy:
   ```sh
   node src/preview.ts --program programs/htoken-no-hollar-borrowers.yaml
   node src/preview.ts --program "$before"
   ```
   Add `--reward-price-usd <price>` only if they give you a PRIME price, and `--csv <file>` if they
   want the per-account list in a spreadsheet. If the preview says there are no snapshots, the
   snapshot data has not been downloaded to this machine; tell them a developer needs to provide
   it, and stop there rather than guessing numbers.
4. If the reader reports an error, fix the file and preview again. The messages name the bad setting.
5. Explain the result and the difference from before in plain words, for example: "Of $3.78M
   supplied, $1.85M would earn. 53 accounts with HOLLAR debt lose their rewards on $1.93M."
   Nobody is excluded today; mention excluded accounts only if the preview shows any.
6. Ask before publishing anything. Once they agree, create a branch named `program/<short-name>`,
   commit only the program file with a message like `programs: allow up to $10 of HOLLAR debt`,
   push, and open a pull request with `gh pr create`. The description should say what changes for
   users in plain language and include the preview's key numbers. Never merge it yourself; review
   by a developer is the safety step.

## Example

"Small HOLLAR leftovers shouldn't cost anyone their rewards, but let's be a bit more generous
than five dollars."

```yaml
applies_from_epoch: 2027-02-03     # the day they asked for, or blank for the developer to fill
max_hollar_debt_usd: 10
```

Change the allowance, ask from which day it should apply and set `applies_from_epoch`, preview
before and after, explain how many more accounts earn and what it does to everyone else's rate, and
point out if the budget and start hour are still blank.
