import express, { type NextFunction, type Request, type Response } from "express";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { collectDefects, collectLaunches, type DefectsData, type LaunchesData } from "./collect.js";
import { clearDatabase, loadSnapshot, saveSnapshot } from "./db.js";
import { collectHistory, type HistoryData } from "./history.js";
import { applyStatus, collectRuns, workflows, type RunsData } from "./runs.js";
import { collectTestCases, requestFullReload, type TestCasesData } from "./testcases.js";
import { getConfig, isConfigured, normalizeEndpoint, normalizeRefresh, REFRESH_KEYS, saveConfig, toPublic, type RefreshKey } from "./config.js";
import { Dataset, ThrottledError, type SnapshotStore } from "./dataset.js";
import { TestOpsClient, TestOpsError } from "./testops.js";

let client: TestOpsClient | null = null;

/** Datasets keep their last result in the database of the current instance. */
function stored<T>(name: string): SnapshotStore<T> {
  return {
    load: () => loadSnapshot<T>(getConfig().endpoint, name),
    save: (data, fetchedAt) => saveSnapshot(getConfig().endpoint, name, data, fetchedAt),
  };
}

function currentClient(): TestOpsClient {
  const cfg = getConfig();
  if (!client || client.endpoint !== cfg.endpoint) client = new TestOpsClient(cfg.endpoint, cfg.token);
  return client;
}

const launches = new Dataset(
  (report) => collectLaunches(currentClient(), report),
  () => getConfig().launchesRefreshSec,
  stored<LaunchesData>("launches"),
);
const defects = new Dataset(
  (report) => collectDefects(currentClient(), report),
  () => getConfig().defectsRefreshSec,
  stored<DefectsData>("defects"),
);
const testCases = new Dataset(
  (report) => collectTestCases(currentClient(), report),
  () => getConfig().testCasesRefreshSec,
  stored<TestCasesData>("testcases"),
);
const runs = new Dataset(
  (report) => collectRuns(currentClient(), report),
  () => getConfig().runsRefreshSec,
  stored<RunsData>("runs"),
);
const history = new Dataset(
  (report) => collectHistory(currentClient(), report),
  () => getConfig().historyRefreshSec,
  stored<HistoryData>("history"),
);

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function requireConfigured(): void {
  if (!isConfigured()) throw new HttpError(409, "Allure TestOps connection is not configured");
}

function parseConnection(body: Record<string, unknown>): { endpoint: string; token: string } {
  let endpoint: string;
  try {
    endpoint = normalizeEndpoint(String(body.endpoint ?? ""));
  } catch {
    throw new HttpError(400, "Invalid endpoint: expected a URL like https://testops.example.com");
  }
  const token = String(body.token ?? "").trim() || getConfig().token;
  if (!token) throw new HttpError(400, "API token is required");
  return { endpoint, token };
}

async function probe(endpoint: string, token: string): Promise<number> {
  try {
    const page = await new TestOpsClient(endpoint, token).get<{ totalElements: number }>("/api/rs/project", { size: "1" });
    return page.totalElements;
  } catch (e) {
    throw new HttpError(502, `Cannot connect to Allure TestOps: ${e instanceof Error ? e.message : String(e)}`);
  }
}

const app = express();
app.use(express.json());

app.get("/api/config", (_req, res) => {
  res.json(toPublic(getConfig()));
});

app.post("/api/config/test", async (req, res) => {
  const { endpoint, token } = parseConnection(req.body ?? {});
  res.json({ projects: await probe(endpoint, token) });
});

app.put("/api/config", async (req, res) => {
  const body = req.body ?? {};
  const { endpoint, token } = parseConnection(body);
  const prev = getConfig();
  const connectionChanged = endpoint !== prev.endpoint || token !== prev.token;
  if (connectionChanged) await probe(endpoint, token);
  saveConfig({
    endpoint,
    token,
    ...(Object.fromEntries(REFRESH_KEYS.map((k) => [k, normalizeRefresh(body[k], prev[k])])) as Record<RefreshKey, number>),
  });
  if (connectionChanged) {
    client = null;
    launches.reset();
    defects.reset();
    testCases.reset();
    history.reset();
    runs.reset();
    clearDatabase();
  }
  res.json(toPublic(getConfig()));
});

app.get("/api/launches", (_req, res) => {
  requireConfigured();
  res.json(launches.read());
});

app.post("/api/launches/refresh", (_req, res) => {
  requireConfigured();
  res.json(launches.refresh());
});

app.get("/api/defects", (_req, res) => {
  requireConfigured();
  res.json(defects.read());
});

app.post("/api/defects/refresh", (_req, res) => {
  requireConfigured();
  res.json(defects.refresh());
});

app.get("/api/runs", (_req, res) => {
  requireConfigured();
  res.json(runs.read());
});

app.post("/api/runs/refresh", (_req, res) => {
  requireConfigured();
  res.json(runs.refresh());
});

app.get("/api/workflows", async (_req, res) => {
  requireConfigured();
  res.json(await workflows(currentClient()));
});

// Writes to Allure TestOps: sets workflow and status on test cases known from
// the last-runs data; ids the application does not know are not touched.
app.post("/api/runs/status", async (req, res) => {
  requireConfigured();
  const body = req.body ?? {};
  const workflowId = Number(body.workflowId);
  const statusId = Number(body.statusId);
  const ids: unknown[] = Array.isArray(body.testCaseIds) ? body.testCaseIds : [];
  if (!Number.isInteger(workflowId) || !Number.isInteger(statusId) || ids.length === 0) {
    throw new HttpError(400, "workflowId, statusId and a non-empty testCaseIds list are required");
  }
  const known = new Map((runs.snapshot().data?.testCases ?? []).map((tc) => [tc.id, tc]));
  const byProject = new Map<number, number[]>();
  const unknownIds: number[] = [];
  for (const raw of ids) {
    const tc = known.get(Number(raw));
    if (!tc) {
      unknownIds.push(Number(raw));
      continue;
    }
    if (!byProject.has(tc.projectId)) byProject.set(tc.projectId, []);
    byProject.get(tc.projectId)!.push(tc.id);
  }
  const client = currentClient();
  const results = await applyStatus(client, byProject, workflowId, statusId);
  const workflow = await client.get<{ id: number; name: string; statuses?: { id: number; name: string; color?: string | null }[] }>(
    `/api/rs/workflow/${workflowId}`,
  );
  const status = workflow.statuses?.find((s) => s.id === statusId);
  const applied = new Set(results.filter((r) => r.error === null).flatMap((r) => byProject.get(r.projectId) ?? []));
  runs.update((data) => {
    for (const tc of data.testCases) {
      if (!applied.has(tc.id)) continue;
      tc.workflow = { id: workflow.id, name: workflow.name };
      tc.status = status ? { id: status.id, name: status.name, color: status.color ?? null } : tc.status;
    }
  });
  res.json({ results, unknownIds });
});

app.get("/api/history", (_req, res) => {
  requireConfigured();
  res.json(history.read());
});

app.post("/api/history/refresh", (_req, res) => {
  requireConfigured();
  res.json(history.refresh());
});

app.get("/api/testcases", (_req, res) => {
  requireConfigured();
  res.json(testCases.read());
});

app.post("/api/testcases/refresh", (req, res) => {
  requireConfigured();
  const full = req.query.full === "true";
  if (full) requestFullReload();
  try {
    res.json(testCases.refresh());
  } catch (e) {
    if (full) requestFullReload(false);
    throw e;
  }
});

app.get("/api/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.use("/api", (_req, _res, next) => next(new HttpError(404, "Not found")));

const webRoot = join(process.cwd(), "web", "dist");
if (existsSync(webRoot)) {
  app.use(express.static(webRoot));
  app.get("/{*path}", (_req, res) => res.sendFile(join(webRoot, "index.html")));
}

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof ThrottledError) {
    res.status(429).set("Retry-After", String(err.retryAfterSec)).json({ error: err.message, retryAfterSec: err.retryAfterSec });
  } else if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message });
  } else if (err instanceof TestOpsError) {
    res.status(502).json({ error: err.message });
  } else {
    console.error(err);
    res.status(500).json({ error: err instanceof Error ? err.message : "Internal error" });
  }
});

const port = Number(process.env.PORT ?? 8080);
app.listen(port, () => {
  console.log(`Allure TestOps analytics listening on :${port}`);
});
