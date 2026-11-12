import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";

// Outputs never contain wall-clock times, so re-running a step on the same inputs gives the same bytes.
export const toJson = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

// The caller names the shape it expects; anything that matters is still checked where it is used.
export const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, "utf8")) as T;

// Writes through a temporary file and a rename, so a crash never leaves a half-written file behind.
export function writeText(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, text);
  renameSync(temporary, path);
}

// Exclusive locks: one runner per data directory, one holder-index scan at a time.
//
// A lock is a file naming its holder: { pid, host, token }, the token being new for every lock taken.
// While held it is touched every minute. It is stale, and taken over, when:
//   - it has not been touched for 10 minutes, whoever has its pid now (pids are reused);
//   - it names this machine and a process that is gone (a crash, a kill -9);
//   - it names this very process, which does not hold it, and has not been touched for 2½ minutes: an
//     earlier run got the same pid, as a runner under a container's init does on every start. (A live
//     holder in another container with the same pid and hostname keeps touching it.)
//   - it cannot be read as a lock and is more than a few seconds old (on a filesystem without hard
//     links, a lock's content is written just after the file is created).
// Every lock still held is released when the process exits, including through process.exit.
export const LOCK_REFRESH_MS = 60_000;
export const LOCK_STALE_MS = 10 * 60_000;
export const LOCK_OWN_PID_STALE_MS = 2.5 * LOCK_REFRESH_MS;
const LOCK_WRITE_GRACE_MS = 5_000;

interface LockOwner {
  pid: number;
  host: string;
  token: string;
}

const held = new Map<string, { token: string; timer: NodeJS.Timeout }>();
let releaseOnExit = false;

const isRunning = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"; // it exists, it is just not ours
  }
};

function readOwner(path: string): LockOwner | null {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Partial<LockOwner> | null;
    const ok = Number.isSafeInteger(value?.pid) && typeof value?.host === "string" && typeof value?.token === "string";
    return ok ? (value as LockOwner) : null;
  } catch {
    return null;
  }
}

function isLive(path: string, owner: LockOwner | null): boolean {
  let age: number;
  try {
    age = Date.now() - statSync(path).mtimeMs;
  } catch {
    return false;
  }
  if (owner === null) return age < LOCK_WRITE_GRACE_MS; // still being written, or not a lock
  if (age > LOCK_STALE_MS) return false;
  if (owner.host !== hostname()) return true; // another machine: only the age can tell
  // Not ours (we would know): an earlier run's, unless another container with our pid keeps it fresh.
  if (owner.pid === process.pid) return age < LOCK_OWN_PID_STALE_MS;
  return isRunning(owner.pid);
}

const NO_HARD_LINKS = new Set(["EPERM", "ENOTSUP", "EOPNOTSUPP", "ENOSYS"]);

function release(path: string, token: string): void {
  const entry = held.get(path);
  if (!entry || entry.token !== token) return;
  clearInterval(entry.timer);
  held.delete(path);
  // Only our own lock: a process that took over a lock we left behind keeps its own.
  if (readOwner(path)?.token === token) rmSync(path, { force: true });
}

// Takes the lock at `path`, or throws when a live holder has it. Returns the function that releases it.
export function acquireLock(path: string, what: string): () => void {
  if (held.has(path)) throw new Error(`${what}: this process already holds ${path}`);
  mkdirSync(dirname(path), { recursive: true });
  const owner: LockOwner = { pid: process.pid, host: hostname(), token: randomUUID() };
  // Written in full first and linked into place, so the lock never exists without its content. Where
  // the filesystem has no hard links, it is created exclusively and written in place instead.
  const content = `${JSON.stringify(owner)}\n`;
  const draft = `${path}.${owner.token}.tmp`;
  writeFileSync(draft, content);
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        linkSync(draft, path);
        break;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code ?? "";
        if (NO_HARD_LINKS.has(code)) {
          try {
            writeFileSync(path, content, { flag: "wx" });
            break;
          } catch (created) {
            if ((created as NodeJS.ErrnoException).code !== "EEXIST") throw created;
          }
        } else if (code !== "EEXIST") {
          throw error;
        }
      }
      if (attempt >= 4) throw new Error(`${what}: could not take the lock ${path}`);
      const current = readOwner(path);
      if (isLive(path, current)) {
        throw new Error(
          current === null
            ? `${what}: another process is taking the lock right now (${path})`
            : `${what} is in use by process ${current.pid} on ${current.host} (${path}; it is taken over once ` +
                `that process is gone or ${LOCK_STALE_MS / 60_000} minutes after its last refresh)`,
        );
      }
      // Take the stale lock over: move it aside under our own name, and if what was moved turns out to be
      // a lock someone else created in the meantime, put it back and look again.
      const aside = `${path}.${owner.token}.stale`;
      try {
        renameSync(path, aside);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      const moved = readOwner(aside);
      if (moved !== null && moved.token !== current?.token) {
        try {
          linkSync(aside, path);
        } catch {
          // a third process holds it by now; it stays the holder
        }
      }
      rmSync(aside, { force: true });
    }
  } finally {
    rmSync(draft, { force: true });
  }

  const timer = setInterval(() => {
    try {
      const now = new Date();
      utimesSync(path, now, now);
    } catch {
      // gone or taken over; the next acquire decides
    }
  }, LOCK_REFRESH_MS);
  timer.unref();
  held.set(path, { token: owner.token, timer });
  if (!releaseOnExit) {
    releaseOnExit = true;
    process.once("exit", () => {
      for (const [lockPath, { token }] of [...held]) release(lockPath, token);
    });
  }
  return () => release(path, owner.token);
}

// Reads <dir>/.env into the environment when the file exists. A variable that is already set in
// the environment keeps its value, so the shell and the service definition win over the file.
export function loadDotEnv(dir: string): void {
  const file = join(dir, ".env");
  if (existsSync(file)) process.loadEnvFile(file);
}

// What to print for something that was thrown.
export const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export const sha256 = (data: string): string => `0x${createHash("sha256").update(data).digest("hex")}`;
