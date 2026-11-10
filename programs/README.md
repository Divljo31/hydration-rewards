# The rewards program file

The program file says who earns PRIME and how much. You can change it without touching code:
edit the file in this folder, run the preview, and open a pull request. A developer reviews it
and runs it from the next epoch. Every epoch's summary records the exact file it used, so any
payout can be traced back to the settings that produced it.

## The settings

```yaml
name: HUSDC and HUSDT, no HOLLAR borrowers    # any description

budget_per_day:                               # PRIME per day, one line per earning asset
  HUSDC: 275.616                              # plain numbers, up to 6 decimal places
  HUSDT: 275.616

epoch_start_hour_utc: 14                      # hour (UTC) each daily epoch starts

earn_on_supply_of: [HUSDC, HUSDT]             # whose supply earns

max_hollar_debt_usd: 5                        # more HOLLAR debt than this: nothing for that hour
```

Leave `budget_per_day` values or `epoch_start_hour_utc` blank while they are undecided. The
preview still works; closing an epoch refuses to run until they are filled in.

Once the first epoch has been closed, `epoch_start_hour_utc` is no longer a simple edit: every
epoch has to start where the one before ended, so a different hour is refused. Changing it needs
a developer.

## Who earns

Every hour the job looks at each account that supplies an earning asset:

- It adds up the account's HOLLAR debt on all three money markets (main, GIGAHDX, BIL), valued at
  each market's oracle price.
- If that debt is more than `max_hollar_debt_usd`, the account earns nothing for that hour, on
  any of its supply. $100k of HUSDT with $1,400 of HOLLAR debt earns nothing.
- Otherwise the account earns on everything it supplies. Hours without the debt still count, so
  repaying HOLLAR restores the reward from the next hour.

`max_hollar_debt_usd` must always be a number. `0` means any HOLLAR debt disqualifies; `5` keeps
a few dollars of leftover debt from disqualifying anyone. It cannot be left blank.

Each asset's daily budget is shared between eligible accounts in proportion to their eligible
value over the day. With a fixed budget, the fewer accounts are eligible, the more each one earns
per dollar.

Accounts that never earn (the Treasury and pallet accounts) are listed in `config/denylist.json`,
which a developer maintains.

What you can change here is the budget, the start hour, which of HUSDC and HUSDT earn, and the
HOLLAR allowance. Anything else — other assets, other kinds of debt, a different rule — needs a
developer.

## Checking the effect

```sh
node src/preview.ts --program programs/htoken-no-hollar-borrowers.yaml
node src/preview.ts --program programs/htoken-no-hollar-borrowers.yaml --csv preview.csv
```

The preview runs the program on the most recent day of snapshots and shows how much supplied
value is eligible, how much the HOLLAR rule removed and from how many accounts, and, with a
budget filled in, what the largest earners would get. The CSV lists every account with its
eligible value and PRIME per day, ready to open in a spreadsheet.

Any typo stops the preview with a message saying what is wrong, for example
`setting "max_holar_debt_usd" is not known. Did you mean max_hollar_debt_usd?`.
