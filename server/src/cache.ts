import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Next to config.json: lives as long as the container or its data volume.
const dir = join(process.env.DATA_DIR ?? join(process.cwd(), "data"), "cache");

export function loadCache<T>(name: string): T | null {
  try {
    return JSON.parse(readFileSync(join(dir, `${name}.json`), "utf8")) as T;
  } catch {
    return null;
  }
}

/** Writes through a temporary file, so a crash never leaves a half-written cache. */
export function saveCache(name: string, value: unknown): void {
  try {
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${name}.json`);
    writeFileSync(`${file}.tmp`, JSON.stringify(value), { mode: 0o600 });
    renameSync(`${file}.tmp`, file);
  } catch (e) {
    console.error(`Cannot save cache ${name}:`, e);
  }
}

export function dropCache(name: string): void {
  rmSync(join(dir, `${name}.json`), { force: true });
}
