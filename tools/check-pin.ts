// Fails unless lib/universal-rewards-distributor is the pinned, unmodified Morpho URD.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const URD_PIN = "3de504b130835a12482e00e1c83dcf369448c80b";

const dir = fileURLToPath(new URL("../contracts/lib/universal-rewards-distributor", import.meta.url));
const git = (...args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();

let head;
try {
  head = git("rev-parse", "HEAD");
} catch {
  console.error("lib/universal-rewards-distributor is missing. Run ./setup.sh first.");
  process.exit(1);
}
if (head !== URD_PIN) {
  console.error(`URD is at ${head}, expected ${URD_PIN}`);
  process.exit(1);
}
const changes = git("status", "--porcelain", "--untracked-files=no");
if (changes) {
  console.error(`URD has local changes; files under lib/universal-rewards-distributor must not be edited:\n${changes}`);
  process.exit(1);
}
console.log(`URD pinned at ${URD_PIN}, no local changes`);
