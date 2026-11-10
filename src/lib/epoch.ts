// An epoch id is the UTC calendar date its window starts on, e.g. "2026-11-12".
const DAY_MS = 86_400_000;

// Milliseconds at 00:00 UTC of the epoch's date. Refuses anything that is not a real date:
// Date would quietly read 2026-11-31 as 1 December and give one window two names.
export function epochDayStart(epoch: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(epoch));
  const ms = m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : NaN;
  if (!m || new Date(ms).toISOString().slice(0, 10) !== epoch) {
    throw new Error(`an epoch must be a date like 2026-11-12, got ${epoch}`);
  }
  return ms;
}

export const addDays = (epoch: string, days: number): string =>
  new Date(epochDayStart(epoch) + days * DAY_MS).toISOString().slice(0, 10);
