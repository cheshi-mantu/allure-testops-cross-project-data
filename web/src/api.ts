export interface PublicConfig {
  endpoint: string;
  tokenSet: boolean;
  tokenHint: string;
  launchesRefreshSec: number;
  defectsRefreshSec: number;
  testCasesRefreshSec: number;
  minRefreshSec: number;
}

export interface ConfigInput {
  endpoint: string;
  /** Empty string keeps the stored token. */
  token: string;
  launchesRefreshSec: number;
  defectsRefreshSec: number;
  testCasesRefreshSec: number;
}

export interface Snapshot<T> {
  data: T | null;
  fetchedAt: number | null;
  refreshing: boolean;
  error: string | null;
  nextRefreshAllowedAt: number;
  nextAutoRefreshAt: number | null;
  progress: string | null;
}

export interface Project {
  id: number;
  name: string;
}

export interface EnvVar {
  name: string;
  value: string;
}

export interface LaunchStatistic {
  passed: number;
  failed: number;
  broken: number;
  skipped: number;
  unknown: number;
  inProgress: number;
}

export interface Launch {
  id: number;
  name: string;
  projectId: number;
  closed: boolean;
  createdBy: string | null;
  createdDate: number | null;
  tags: string[];
  env: EnvVar[];
  /** null when the counts could not be loaded. */
  statistic: LaunchStatistic | null;
  unresolved: number | null;
  muted: number | null;
  newDefects: number | null;
  knownDefects: number | null;
}

export interface LaunchesData {
  endpoint: string;
  projects: Project[];
  launches: Launch[];
  /** Closed launches of this many last days are included when they have unresolved results. */
  closedLaunchesDays: number;
  failedProjects: { id: number; error: string }[];
}

export interface Issue {
  name: string;
  url: string | null;
}

export interface DefectMatcher {
  id: number;
  name: string;
  messageRegex: string | null;
  traceRegex: string | null;
}

export interface Defect {
  id: number;
  name: string;
  projectId: number;
  closed: boolean;
  createdBy: string | null;
  /** "matcher": the API has no defect creator, the first matcher's author stands in. */
  creatorSource: "defect" | "matcher" | null;
  createdDate: number | null;
  issues: Issue[];
  /** null when the matchers could not be loaded. */
  matchers: DefectMatcher[] | null;
  testCases: number | null;
  testResults: number | null;
  launches: number | null;
}

export interface DefectsData {
  endpoint: string;
  projects: Project[];
  defects: Defect[];
  failedProjects: { id: number; error: string }[];
}

export interface TestCase {
  id: number;
  name: string;
  projectId: number;
  /** false when the details could not be loaded; only id and name are known then. */
  detailed: boolean;
  modified: number | null;
  /** null when unknown. */
  automated: boolean | null;
  layer: string | null;
  tags: string[];
  issues: Issue[];
  members: { role: string; name: string }[];
  customFields: { name: string; values: string[] }[];
}

export interface TestCasesData {
  endpoint: string;
  projects: Project[];
  failedProjects: { id: number; error: string }[];
  testCases: TestCase[];
  /** What the last crawl did: details loaded anew versus taken from the cache. */
  sync: { full: boolean; loaded: number; reused: number; removed: number; fullReloadAt: number };
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfterSec?: number,
  ) {
    super(message);
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new ApiError(payload.error ?? res.statusText, res.status, payload.retryAfterSec);
  }
  return payload as T;
}

export const api = {
  getConfig: () => call<PublicConfig>("GET", "/api/config"),
  saveConfig: (cfg: ConfigInput) => call<PublicConfig>("PUT", "/api/config", cfg),
  testConfig: (cfg: Pick<ConfigInput, "endpoint" | "token">) =>
    call<{ projects: number }>("POST", "/api/config/test", cfg),
  launches: () => call<Snapshot<LaunchesData>>("GET", "/api/launches"),
  refreshLaunches: () => call<Snapshot<LaunchesData>>("POST", "/api/launches/refresh"),
  defects: () => call<Snapshot<DefectsData>>("GET", "/api/defects"),
  refreshDefects: () => call<Snapshot<DefectsData>>("POST", "/api/defects/refresh"),
  testCases: () => call<Snapshot<TestCasesData>>("GET", "/api/testcases"),
  refreshTestCases: () => call<Snapshot<TestCasesData>>("POST", "/api/testcases/refresh"),
  reloadAllTestCases: () => call<Snapshot<TestCasesData>>("POST", "/api/testcases/refresh?full=true"),
};
