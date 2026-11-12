// The command-line entry points, run as separate processes on throwaway data.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { epochWindow } from "../src/close-epoch.ts";
import { loadDotEnv } from "../src/lib/io.ts";
import { ACCOUNTS, hourly, makeDataDir } from "./helpers.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const EPOCH = "2026-11-12";
const { start } = epochWindow(EPOCH, 14);

function run(script: string, ...args: string[]) {
  const r = spawnSync(process.execPath, [join(root, "src", script), ...args], { encoding: "utf8" });
  return { status: r.status, out: r.stdout, err: r.stderr };
}

const programText = (husdt: number) => `name: cli test
applies_from_epoch: 2026-11-12
budget_per_day:
  HUSDC: 1
  HUSDT: ${husdt}
epoch_start_hour_utc: 14
earn_on_supply_of: [HUSDC, HUSDT]
max_hollar_debt_usd: 5
`;

// A data directory with one full epoch, and a program file that lives outside the repository.
function setup() {
  const { dataDir, denylistPath } = makeDataDir({
    snapshots: hourly(start, () => ({
      [ACCOUNTS.a]: { husdc: 10, husdt: 10 },
      [ACCOUNTS.b]: { husdt: 30, hollar: 20 },
    })),
  });
  const program = join(mkdtempSync(join(tmpdir(), "hydration-program-")), "program.yaml");
  writeFileSync(program, programText(2));
  const close = (...extra: string[]) =>
    run(
      "close-epoch.ts",
      "--epoch",
      EPOCH,
      "--program",
      program,
      "--data",
      dataDir,
      "--denylist",
      denylistPath,
      ...extra,
    );
  return { dataDir, denylistPath, program, close };
}

test("close-epoch writes the CSV, summary and tree, and repeating it changes nothing", () => {
  const { dataDir, close } = setup();
  const first = close("--genesis");
  assert.equal(first.status, 0, first.err);
  assert.match(first.out, /24 snapshots, 1 accounts paid, distributed 3000000, dust 0, root 0x[0-9a-f]{64}/);
  assert.equal(
    readFileSync(join(dataDir, "epochs", `${EPOCH}.csv`), "utf8"),
    `account,amount\n${ACCOUNTS.a},3000000\n`,
  );
  const tree = readFileSync(join(dataDir, "trees", `${EPOCH}.json`), "utf8");
  const summary = JSON.parse(readFileSync(join(dataDir, "epochs", `${EPOCH}.summary.json`), "utf8"));
  assert.equal(summary.program.name, "cli test");
  assert.equal(summary.hollarBorrowers.accounts, 1);

  const again = close("--genesis");
  assert.equal(again.status, 0, again.err);
  assert.equal(readFileSync(join(dataDir, "trees", `${EPOCH}.json`), "utf8"), tree);
});

test("close-epoch refuses to replace an epoch that was closed with a different result", () => {
  const { dataDir, program, close } = setup();
  assert.equal(close("--genesis").status, 0);
  const tree = readFileSync(join(dataDir, "trees", `${EPOCH}.json`), "utf8");

  writeFileSync(program, programText(5)); // someone edits the budget and closes the same epoch again
  const changed = close("--genesis");
  assert.equal(changed.status, 1);
  assert.match(changed.err, /already closed with a different result/);
  assert.equal(readFileSync(join(dataDir, "trees", `${EPOCH}.json`), "utf8"), tree);

  assert.equal(close("--genesis", "--overwrite").status, 0);
  assert.notEqual(readFileSync(join(dataDir, "trees", `${EPOCH}.json`), "utf8"), tree);
});

test("close-epoch takes its settings from a program file only", () => {
  const { dataDir, close } = setup();
  const noProgram = run("close-epoch.ts", "--epoch", EPOCH, "--data", dataDir, "--genesis");
  assert.equal(noProgram.status, 1);
  assert.match(noProgram.err, /--program is required/);

  const oldFlag = close("--genesis", "--budget", "HUSDT=5");
  assert.equal(oldFlag.status, 1);
  assert.match(oldFlag.err, /Unknown option '--budget'/);

  const noPrevious = close();
  assert.equal(noPrevious.status, 1);
  assert.match(noPrevious.err, /previous tree is required/);
  assert.equal(existsSync(join(dataDir, "trees")), false);
});

test("preview works for a program file outside the repository and writes nothing but the CSV asked for", () => {
  const { dataDir, denylistPath, program } = setup();
  const csv = join(dataDir, "preview.csv");
  const r = run(
    "preview.ts",
    "--program",
    program,
    "--data",
    dataDir,
    "--denylist",
    denylistPath,
    "--csv",
    csv,
    "--reward-price-usd",
    "1.07",
  );
  assert.equal(r.status, 0, r.err);
  assert.match(r.out, /Snapshots 24 /);
  assert.match(r.out, /HOLLAR debt above \$5\.00 \(1 accounts\)\s+-\$30/);
  assert.match(r.out, /Accounts earning: 1/);
  assert.match(r.out, /APR at \$1\.07/);
  assert.match(
    readFileSync(csv, "utf8"),
    new RegExp(`^account,eligible_usd,prime_per_day\\n${ACCOUNTS.a},20\\.00,3\\.000000\\n`),
  );
  assert.equal(existsSync(join(dataDir, "epochs")), false);

  const byEpoch = run(
    "preview.ts",
    "--program",
    program,
    "--data",
    dataDir,
    "--denylist",
    denylistPath,
    "--epoch",
    EPOCH,
  );
  assert.equal(byEpoch.status, 0, byEpoch.err);
  assert.match(byEpoch.out, /Snapshots 24 /);

  const empty = run("preview.ts", "--program", program, "--data", join(dataDir, "nowhere"));
  assert.equal(empty.status, 1);
  assert.match(empty.err, /no snapshot data yet/);
});

test("snapshot only accepts a whole hour, and has no way to pick a block or an epoch by hand", () => {
  const data = mkdtempSync(join(tmpdir(), "hydration-rewards-"));
  const offTheHour = run("snapshot.ts", "--at", "2026-11-12T15:00:30Z", "--data", data, "--rpc", "http://127.0.0.1:1");
  assert.equal(offTheHour.status, 1);
  assert.match(offTheHour.err, /must be a multiple of 3600 seconds/);

  // Without its zone the time would be read in this machine's zone: refused before anything is read.
  const noZone = run("snapshot.ts", "--at", "2026-11-12T15:00:00", "--data", data, "--rpc", "http://127.0.0.1:1");
  assert.equal(noZone.status, 1);
  assert.match(noZone.err, /--at takes unix seconds or a time with its zone/);

  for (const flag of ["--block", "--epoch", "--epoch-start-hour"]) {
    const r = run("snapshot.ts", flag, "1", "--data", data);
    assert.equal(r.status, 1);
    assert.match(r.err, new RegExp(`Unknown option '${flag}'`));
  }
  assert.match(run("snapshot.ts", "--data", data).err, /pass --at <time>/);
});

test("a .env file is read, and a variable already set in the environment wins over it", () => {
  const dir = mkdtempSync(join(tmpdir(), "hydration-env-"));
  writeFileSync(
    join(dir, ".env"),
    "REWARDS_TEST_FROM_SHELL=file\nREWARDS_TEST_FROM_FILE=file\n# a comment\nREWARDS_TEST_EMPTY=\n",
  );
  process.env.REWARDS_TEST_FROM_SHELL = "shell";
  loadDotEnv(dir);
  assert.equal(process.env.REWARDS_TEST_FROM_SHELL, "shell");
  assert.equal(process.env.REWARDS_TEST_FROM_FILE, "file");
  assert.equal(process.env.REWARDS_TEST_EMPTY, "");
  assert.doesNotThrow(() => loadDotEnv(mkdtempSync(join(tmpdir(), "hydration-env-")))); // no file, nothing to do
});

test("--index-only refuses a node that serves another chain before it scans anything", () => {
  const data = mkdtempSync(join(tmpdir(), "hydration-rewards-"));
  // A node for chain 1, loaded into the process in place of the network.
  const stub = join(mkdtempSync(join(tmpdir(), "hydration-stub-")), "fetch-stub.mjs");
  writeFileSync(
    stub,
    "globalThis.fetch = async (_url, init) => {\n" +
      "  const body = JSON.parse(init.body);\n" +
      '  const answer = (r) => ({ jsonrpc: "2.0", id: r.id, result: r.method === "eth_chainId" ? "0x1" : null });\n' +
      "  return new Response(JSON.stringify(Array.isArray(body) ? body.map(answer) : answer(body)));\n" +
      "};\n",
  );
  const r = spawnSync(
    process.execPath,
    [
      "--import",
      pathToFileURL(stub).href,
      join(root, "src", "snapshot.ts"),
      "--index-only",
      "--data",
      data,
      "--rpc",
      "http://node.invalid",
    ],
    { encoding: "utf8" },
  );
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stderr, /serves chain 1, but the config is for chain 222222/);
  assert.equal(existsSync(join(data, "state")), false);
});
