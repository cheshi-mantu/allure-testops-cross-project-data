import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const MIN_REFRESH_SEC = 60;

export interface AppConfig {
  endpoint: string;
  token: string;
  /** Auto refresh period for launches, seconds. 0 disables auto refresh. */
  launchesRefreshSec: number;
  /** Auto refresh period for defects, seconds. 0 disables auto refresh. */
  defectsRefreshSec: number;
  /** Auto refresh period for test cases, seconds. 0 disables auto refresh. */
  testCasesRefreshSec: number;
}

/** What the UI is allowed to see: the token never leaves the container. */
export interface PublicConfig {
  endpoint: string;
  tokenSet: boolean;
  tokenHint: string;
  launchesRefreshSec: number;
  defectsRefreshSec: number;
  testCasesRefreshSec: number;
  minRefreshSec: number;
}

const DEFAULTS: AppConfig = {
  endpoint: "",
  token: "",
  launchesRefreshSec: 300,
  defectsRefreshSec: 0,
  testCasesRefreshSec: 0,
};

// The file lives in the container's writable layer: it survives a container
// restart and disappears together with the container.
const file = join(process.env.DATA_DIR ?? join(process.cwd(), "data"), "config.json");

let current: AppConfig = load();

function load(): AppConfig {
  try {
    return { ...DEFAULTS, ...JSON.parse(readFileSync(file, "utf8")) };
  } catch {
    return { ...DEFAULTS };
  }
}

export function getConfig(): AppConfig {
  return current;
}

export function isConfigured(): boolean {
  return current.endpoint !== "" && current.token !== "";
}

export function normalizeRefresh(value: unknown, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  if (n <= 0) return 0;
  return Math.max(MIN_REFRESH_SEC, Math.round(n));
}

export function normalizeEndpoint(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, "");
  const url = new URL(trimmed);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Endpoint must be an http(s) URL");
  }
  return trimmed;
}

export function saveConfig(next: AppConfig): void {
  current = next;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(next, null, 2), { mode: 0o600 });
}

export function toPublic(cfg: AppConfig): PublicConfig {
  return {
    endpoint: cfg.endpoint,
    tokenSet: cfg.token !== "",
    tokenHint: cfg.token ? `…${cfg.token.slice(-4)}` : "",
    launchesRefreshSec: cfg.launchesRefreshSec,
    defectsRefreshSec: cfg.defectsRefreshSec,
    testCasesRefreshSec: cfg.testCasesRefreshSec,
    minRefreshSec: MIN_REFRESH_SEC,
  };
}
