// The lock that allows one runner per data directory and one holder-index scan at a time.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { acquireLock, LOCK_OWN_PID_STALE_MS, LOCK_REFRESH_MS, LOCK_STALE_MS } from "../src/lib/io.ts";

const lockPath = () => join(mkdtempSync(join(tmpdir(), "hydration-lock-")), "x.lock");
const ownerOf = (path: string) => JSON.parse(readFileSync(path, "utf8"));
function write(path: string, owner: object, ageMs = 0): void {
  writeFileSync(path, JSON.stringify(owner));
  if (ageMs > 0) {
    const then = new Date(Date.now() - ageMs);
    utimesSync(path, then, then);
  }
}
const gonePid = (): number => spawnSync(process.execPath, ["-e", ""]).pid ?? 0; // has exited by now
const livePid = process.ppid; // the test runner: running, and not this process

test("a lock is taken and released, and one process cannot take it twice", () => {
  const path = lockPath();
  const release = acquireLock(path, "the thing");
  assert.equal(ownerOf(path).pid, process.pid);
  assert.equal(ownerOf(path).host, hostname());
  assert.match(ownerOf(path).token, /^[0-9a-f-]{36}$/);
  assert.throws(() => acquireLock(path, "the thing"), /this process already holds/);
  release();
  assert.equal(existsSync(path), false);
  release(); // a second release changes nothing
  acquireLock(path, "the thing")();
});

test("a lock held by another running process on this machine is refused and left as it is", () => {
  const path = lockPath();
  write(path, { pid: livePid, host: hostname(), token: "theirs" });
  assert.throws(
    () => acquireLock(path, "the thing"),
    new RegExp(`the thing is in use by process ${livePid} on ${hostname()}`),
  );
  assert.equal(ownerOf(path).token, "theirs");
});

test("a lock from another machine is honoured while it is refreshed, whatever its pid is here", () => {
  const path = lockPath();
  const pid = gonePid(); // no such process here, which says nothing about the other machine
  write(path, { pid, host: "elsewhere", token: "far" });
  assert.throws(() => acquireLock(path, "the thing"), new RegExp(`in use by process ${pid} on elsewhere`));
});

test("a fresh lock naming this process's pid is honoured: another container can have the same pid and hostname", () => {
  const path = lockPath();
  write(path, { pid: process.pid, host: hostname(), token: "other container" }, LOCK_REFRESH_MS);
  assert.throws(() => acquireLock(path, "the thing"), /in use by process/);
  // A lock being written by another process right now is not taken over either.
  const writing = lockPath();
  writeFileSync(writing, "");
  assert.throws(() => acquireLock(writing, "the thing"), /another process is taking the lock right now/);
});

test("stale locks are taken over", () => {
  const cases: [string, object, number][] = [
    ["its process is gone", { pid: gonePid(), host: hostname(), token: "crashed" }, 0],
    // A runner restarted under a container's init gets the same pid every time.
    [
      "it names this process, from an earlier run",
      { pid: process.pid, host: hostname(), token: "earlier" },
      LOCK_OWN_PID_STALE_MS + 1_000,
    ],
    // Its pid now belongs to an unrelated process; the holder would have refreshed it.
    ["not refreshed for 10 minutes", { pid: livePid, host: hostname(), token: "reused" }, LOCK_STALE_MS + 60_000],
    ["another machine, not refreshed", { pid: 1, host: "elsewhere", token: "far" }, LOCK_STALE_MS + 60_000],
  ];
  for (const [label, owner, age] of cases) {
    const path = lockPath();
    write(path, owner, age);
    const release = acquireLock(path, "the thing");
    assert.equal(ownerOf(path).pid, process.pid, label);
    release();
  }
  const unreadable = lockPath();
  writeFileSync(unreadable, "");
  const old = new Date(Date.now() - 10_000);
  utimesSync(unreadable, old, old);
  acquireLock(unreadable, "the thing")();
});

test("a held lock is refreshed every minute, so its holder is never taken for gone", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const path = lockPath();
  const release = acquireLock(path, "the thing");
  const old = new Date(Date.now() - LOCK_STALE_MS + 30_000);
  utimesSync(path, old, old);
  t.mock.timers.tick(LOCK_REFRESH_MS);
  const { mtimeMs } = statSync(path);
  assert.ok(Date.now() - mtimeMs < 10_000, "touched by the refresh");
  release();
  t.mock.timers.reset();
});

test("a lock that was taken over is not removed by its former holder", () => {
  const path = lockPath();
  const release = acquireLock(path, "the thing");
  write(path, { pid: livePid, host: hostname(), token: "new holder" });
  release();
  assert.equal(ownerOf(path).token, "new holder");
});

test("every lock still held is released when the process exits, through process.exit too", () => {
  const path = lockPath();
  const io = new URL("../src/lib/io.ts", import.meta.url).href;
  const code = `import { acquireLock } from ${JSON.stringify(io)}; acquireLock(${JSON.stringify(path)}, "x"); process.exit(0);`;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(existsSync(path), false);
});
