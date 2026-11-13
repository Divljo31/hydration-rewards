# The rewards program file

The program file says who earns PRIME and how much. You can change it without touching code:
edit the file in this folder, run the preview, and open a pull request. A developer reviews it,
and it takes effect at the epoch it names in `applies_from_epoch`. Every epoch's summary records
the exact file it used, so any payout can be traced back to the settings that produced it.

## The settings

```yaml
name: HUSDC, HUSDT and HEURC, no HOLLAR borrowers   # any description

applies_from_epoch: 2027-01-15                # the first daily epoch these settings pay

budget_per_day:                               # PRIME per day, one line per earning asset
  HUSDC: 275.616                              # plain numbers, up to 6 decimal places
  HUSDT: 275.616
  HEURC: 100                                  # each asset has a budget of its own

epoch_start_hour_utc: 14                      # hour (UTC) each daily epoch starts

earn_on_supply_of: [HUSDC, HUSDT, HEURC]      # whose supply earns

max_hollar_debt_usd: 5                        # more HOLLAR debt than this: nothing for that hour
```

Leave `applies_from_epoch`, `budget_per_day` values or `epoch_start_hour_utc` blank while they
are undecided. The preview still works; closing an epoch refuses to run until they are filled in.

`applies_from_epoch` is the date of the first daily epoch the file pays; that epoch starts at
`epoch_start_hour_utc` on that date. Every change to the file, even a small one, moves it to an
epoch that has not been closed yet, normally the day after the pull request is merged or later.
Closing an earlier epoch with the file is refused, and so is closing a later one when the file
changed without moving the date. That way a change takes effect exactly where the reviewed file
says, whenever the job picks it up.

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

No account is excluded by name: the Treasury and pallet accounts are treated like any other holder of
supplied HUSDC, HUSDT or HEURC, and the HOLLAR rule applies to them too.
`config/denylist.json`, which a developer maintains, can exclude accounts, and it is empty.

What you can change here is the budget, the start hour, which of HUSDC, HUSDT and HEURC earn, the
HOLLAR allowance, and the epoch a change starts from. Anything else — other assets, other kinds of
debt, a different rule — needs a developer.

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
