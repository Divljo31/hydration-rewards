import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
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

// Reads <dir>/.env into the environment when the file exists. A variable that is already set in
// the environment keeps its value, so the shell and the service definition win over the file.
export function loadDotEnv(dir: string): void {
  const file = join(dir, ".env");
  if (existsSync(file)) process.loadEnvFile(file);
}

// What to print for something that was thrown.
export const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export const sha256 = (data: string): string => `0x${createHash("sha256").update(data).digest("hex")}`;
