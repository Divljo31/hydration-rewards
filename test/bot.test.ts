// The runner's tick against a data directory, with snapshots supplied by the test instead of a chain.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tick } from "../src/bot.ts";
import { epochWindow } from "../src/close-epoch.ts";
import { toJson } from "../src/lib/io.ts";
import { parseProgram } from "../src/program.ts";
import { ACCOUNTS, makeDataDir, makeSnapshot, parseCsv } from "./helpers.ts";
import type { DenylistFile } from "../src/lib/denylist.ts";
import type { Tree } from "../src/types.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const config = JSON.parse(readFileSync(join(root, "config", "mainnet.json"), "utf8"));
const FIRST = "2026-11-12";
const { start } = epochWindow(FIRST, 14);
const HOUR = 3600;

const PROGRAM = `name: bot test
budget_per_day:
  HUSDC: 1
  HUSDT: 1
epoch_start_hour_utc: 14
earn_on_supply_of: [HUSDC, HUSDT]
max_hollar_debt_usd: 5
`;
const program = parseProgram(PROGRAM, config, { requireDecisions: true });

// A runner over an empty data directory. Each hour's snapshot holds one account, a on even days of
// the month and b on odd ones, so the trees show which epochs were closed.
function runner({
  failAt = null,
  notFinalizedFrom = Infinity,
  noBlockAt = null,
  denylist = undefined,
}: {
  failAt?: number | null;
  notFinalizedFrom?: number;
  noBlockAt?: number | null;
  denylist?: DenylistFile;
} = {}) {
  const { dataDir, denylistPath } = makeDataDir({ snapshots: [], ...(denylist ? { denylist } : {}) });
  const asked: number[] = [];
  const takeHour = async (target: number) => {
    asked.push(target);
    if (target >= notFinalizedFrom) throw Object.assign(new Error("no finalized block yet"), { code: "NOT_FINALIZED" });
    if (target === failAt) throw new Error("eth_call: execution reverted");
    if (target === noBlockAt) throw Object.assign(new Error("no block in this hour"), { code: "NO_BLOCK_IN_HOUR" });
    const account = new Date((target - 14 * HOUR) * 1000).getUTCDate() % 2 === 0 ? ACCOUNTS.a : ACCOUNTS.b;
    const snapshot = makeSnapshot({
      number: target / 6,
      timestamp: target + 2,
      target,
      accounts: { [account]: { husdt: 10 } },
    });
    writeFileSync(join(dataDir, "snapshots", `${target}.json`), toJson(snapshot));
  };
  const run = (now: number, extra: Partial<Parameters<typeof tick>[0]> = {}) =>
    tick({ now, dataDir, program, config, denylistPath, firstEpoch: FIRST, takeHour, ...extra });
  const tree = (epoch: string): Tree => JSON.parse(readFileSync(join(dataDir, "trees", `${epoch}.json`), "utf8"));
  return { dataDir, asked, run, tree };
}

test("nothing happens before the first epoch starts", async () => {
  const { asked, run } = runner();
  const status = await run(start - 1);
  assert.deepEqual(asked, []);
  assert.equal(status.openEpoch, FIRST);
  assert.match(String(status.waiting), /first epoch starts at 2026-11-12T14:00:00/);
});

test("each due hour is snapshotted once, and an epoch is closed when its last hour is in", async () => {
  const { dataDir, asked, run, tree } = runner();

  let status = await run(start + 2 * HOUR + 59);
  assert.deepEqual(asked, [start, start + HOUR, start + 2 * HOUR]);
  assert.deepEqual(status, {
    openEpoch: FIRST,
    snapshots: 3,
    taken: asked,
    closed: [],
    latestTree: null,
    waiting: null,
    blocked: [],
  });

  status = await run(start + 2 * HOUR + 119); // a minute later: nothing new is due
  assert.equal(asked.length, 3);
  assert.deepEqual(status.taken, []);

  status = await run(start + 23 * HOUR); // the 24th hour
  assert.equal(asked.length, 24);
  assert.equal(status.closed.length, 1);
  assert.equal(status.closed[0].epoch, FIRST);
  assert.equal(status.closed[0].distributed, "1000000");
  assert.equal(status.openEpoch, "2026-11-13");
  assert.equal(status.snapshots, 0);
  assert.deepEqual(status.latestTree, { epoch: FIRST, root: tree(FIRST).root, sha256: status.closed[0].treeSha256 });
  assert.equal(tree(FIRST).previousRoot, null); // the first epoch is the genesis tree
  assert.deepEqual([...parseCsv(readFileSync(join(dataDir, "epochs", `${FIRST}.csv`), "utf8")).keys()], [ACCOUNTS.a]);
});

test("after downtime it catches up: missed hours first, then every finished epoch in order", async () => {
  const { asked, run, tree } = runner();
  await run(start + 5 * HOUR);
  // Down for two days, back at hour 50.
  const status = await run(start + 50 * HOUR + 10);
  assert.equal(asked.length, 51);
  assert.deepEqual(
    asked,
    [...asked].sort((x, y) => x - y),
  ); // oldest first
  assert.deepEqual(
    status.closed.map((c) => c.epoch),
    ["2026-11-12", "2026-11-13"],
  );
  assert.equal(status.openEpoch, "2026-11-14");
  assert.equal(status.snapshots, 3);
  // Each tree builds on the day before, and carries its accounts forward.
  assert.equal(tree("2026-11-13").previousRoot, tree("2026-11-12").root);
  assert.equal(tree("2026-11-13").claims[ACCOUNTS.a].claimable, "1000000");
  assert.equal(tree("2026-11-13").claims[ACCOUNTS.b].claimable, "1000000");
});

test("a failed snapshot stops the tick; the next tick carries on from the same hour", async () => {
  const failing = runner({ failAt: start + 10 * HOUR });
  await assert.rejects(failing.run(start + 30 * HOUR), /execution reverted/);
  assert.equal(failing.asked.at(-1), start + 10 * HOUR);
  assert.equal(existsSync(join(failing.dataDir, "trees")), false); // nothing closed with an hour missing

  const { asked, run } = runner();
  await run(start + 9 * HOUR);
  const status = await run(start + 30 * HOUR);
  assert.equal(asked.length, 31);
  assert.equal(status.closed.length, 1);
});

test("an hour whose block is not finalized yet is waited for, not reported as a failure", async () => {
  const { asked, run } = runner({ notFinalizedFrom: start + 3 * HOUR });
  const status = await run(start + 4 * HOUR);
  assert.deepEqual(status.taken, [start, start + HOUR, start + 2 * HOUR]);
  assert.match(String(status.waiting), /2026-11-12T17:00:00.000Z is not finalized yet/);
  assert.equal(asked.at(-1), start + 3 * HOUR); // the hour after it is not even tried
});

test("a backlog larger than the limit is refused, so a wrong first epoch cannot start a year of snapshots", async () => {
  const { asked, run } = runner();
  await assert.rejects(run(start + 400 * HOUR), /401 snapshots are overdue since 2026-11-12T14:00:00.000Z/);
  assert.deepEqual(asked, []);
  await assert.rejects(run(start, { firstEpoch: "12 Nov" }), /must be a date like 2026-11-12/);
});

test("the bot refuses to start without a first epoch or with a program whose decisions are blank", () => {
  const data = mkdtempSync(join(tmpdir(), "hydration-rewards-"));
  const bot = (...args: string[]) =>
    spawnSync(
      process.execPath,
      [join(root, "src", "bot.ts"), "--once", "--data", data, "--rpc", "http://127.0.0.1:1", ...args],
      {
        encoding: "utf8",
        env: { ...process.env, FIRST_EPOCH: "", PROGRAM: "" },
      },
    );
  const noEpoch = bot();
  assert.equal(noEpoch.status, 1);
  assert.match(noEpoch.stderr, /--first-epoch \(or FIRST_EPOCH\) is required/);

  const blank = bot("--first-epoch", FIRST, "--program", join(root, "programs", "htoken-no-hollar-borrowers.yaml"));
  assert.equal(blank.status, 1);
  assert.match(blank.stderr, /is blank; fill it in before closing an epoch/);

  // With decisions made and an epoch that has not started, one tick writes the status file and exits.
  const programPath = join(data, "program.yaml");
  writeFileSync(programPath, PROGRAM);
  const idle = bot("--first-epoch", "2999-01-01", "--program", programPath);
  assert.equal(idle.status, 0, idle.stderr);
  const status = JSON.parse(readFileSync(join(data, "status.json"), "utf8"));
  assert.equal(status.error, null);
  assert.equal(status.openEpoch, "2999-01-01");
  assert.match(String(status.waiting), /first epoch starts at 2999-01-01T14:00:00/);
});

test("an hour the chain produced no block in does not stop later hours, and leaves its epoch for a person to close", async () => {
  const { dataDir, asked, run } = runner({ noBlockAt: start + 5 * HOUR });
  const status = await run(start + 30 * HOUR);
  assert.equal(asked.length, 31); // every hour was tried, including the ones after the stall
  assert.equal(status.taken.length, 30);
  assert.deepEqual(status.blocked, ["2026-11-12T19:00:00.000Z"]);
  assert.equal(status.openEpoch, FIRST);
  assert.equal(status.closed.length, 0);
  assert.match(String(status.waiting), /epoch 2026-11-12 cannot close on its own.*--allow-partial/);
  assert.equal(existsSync(join(dataDir, "trees")), false);
});

test("a first epoch later than trees that already exist is refused instead of starting over from genesis", async () => {
  const { run } = runner();
  await run(start + 24 * HOUR); // closes 2026-11-12
  // Restarted with the date read as "resume from here".
  await assert.rejects(
    run(start + 49 * HOUR, { firstEpoch: "2026-11-13" }),
    /already holds 2026-11-12\.json; check the first epoch/,
  );
  // With the right date the same restart simply carries on.
  const status = await run(start + 49 * HOUR);
  assert.deepEqual(
    status.closed.map((c) => c.epoch),
    ["2026-11-13"],
  );
});

test("a provisional denylist is called out next to the root to post", async () => {
  const lines: string[] = [];
  const provisional = { rules: { palletAccounts: true }, addresses: [], unresolved: ["ICE pot"] };
  const status = await runner({ denylist: provisional }).run(start + 23 * HOUR, { log: (line) => lines.push(line) });
  assert.equal(status.closed[0].denylistProvisional, true);
  assert.match(
    lines.join("\n"),
    /to post: submitRoot\(0x[0-9a-f]{64}, 0x[0-9a-f]{64}\)\n\s+WARNING: the denylist is provisional/,
  );

  const clean: string[] = [];
  await runner().run(start + 23 * HOUR, { log: (line) => clean.push(line) });
  assert.doesNotMatch(clean.join("\n"), /WARNING/);
});
