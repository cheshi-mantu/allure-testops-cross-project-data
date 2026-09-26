import type { Project } from "./collect.js";
import { database, defineTables, tx } from "./db.js";
import { mapLimit } from "./pool.js";
import type { TestOpsClient } from "./testops.js";

/**
 * When each test case last ran. Launches of the last LOOKBACK_DAYS are read
 * once they are closed (open ones again on every refresh), and every test case
 * with a finished result in a launch gets the launch's date. Test cases not
 * seen in these launches are checked once for any finished result at all.
 */

export const LOOKBACK_DAYS = 90;
const NEVER_RUN_CHUNK = 100;

interface ApiNamed {
  id: number;
  name: string;
  color?: string | null;
}

interface ApiTestCase {
  id: number;
  name: string;
  automated?: boolean | null;
  createdDate?: number | null;
  status?: ApiNamed | null;
  workflow?: ApiNamed | null;
}

interface ApiLaunch {
  id: number;
  closed?: boolean;
  createdDate?: number | null;
}

interface ApiTestResultRow {
  id: number;
  testCaseId?: number | null;
}

export interface RunTestCase {
  id: number;
  name: string;
  projectId: number;
  automated: boolean | null;
  created: number | null;
  status: { id: number; name: string; color: string | null } | null;
  workflow: { id: number; name: string } | null;
  /** Date of the latest launch in the lookback window with a finished result; null when none. */
  lastRun: number | null;
  /** false: never ran; true: ran, maybe before the window; null: not known yet. */
  everRun: boolean | null;
}

export interface RunsData {
  endpoint: string;
  projects: Project[];
  failedProjects: { id: number; error: string }[];
  lookbackDays: number;
  testCases: RunTestCase[];
  sync: { launchesRead: number; neverRunChecked: number };
}

type Report = (progress: string) => void;

defineTables(
  `
    create table if not exists run_launch (
      id integer primary key,
      project_id integer not null,
      created integer,
      -- read after it was closed, so it will not change any more
      done integer not null default 0
    );
    create table if not exists tc_run (
      tc_id integer primary key,
      last_run integer,
      ever_run integer
    );
  `,
  ["run_launch", "tc_run"],
);

const FINISHED = "status != null";

export async function collectRuns(client: TestOpsClient, report: Report): Promise<RunsData> {
  const d = database(client.endpoint);
  const since = Date.now() - LOOKBACK_DAYS * 86_400_000;
  report("Loading projects");
  const projects = await client.projects();
  const failedProjects: RunsData["failedProjects"] = [];

  const testCases: RunTestCase[] = [];
  const launches: { launch: ApiLaunch; projectId: number }[] = [];
  let listed = 0;
  await mapLimit(projects, 4, async (p) => {
    try {
      const [cases, recent] = await Promise.all([
        client.all<ApiTestCase>("/api/rs/testcase/__search", { projectId: String(p.id), rql: "true", sort: "id,asc" }),
        client.all<ApiLaunch>("/api/rs/launch/__search", { projectId: String(p.id), rql: `createdDate >= ${since}`, sort: "id,asc" }),
      ]);
      for (const tc of cases) {
        testCases.push({
          id: tc.id,
          name: tc.name,
          projectId: p.id,
          automated: tc.automated ?? null,
          created: tc.createdDate ?? null,
          status: tc.status ? { id: tc.status.id, name: tc.status.name, color: tc.status.color ?? null } : null,
          workflow: tc.workflow ? { id: tc.workflow.id, name: tc.workflow.name } : null,
          lastRun: null,
          everRun: null,
        });
      }
      launches.push(...recent.map((launch) => ({ launch, projectId: p.id })));
    } catch (e) {
      failedProjects.push({ id: p.id, error: e instanceof Error ? e.message : String(e) });
    } finally {
      report(`Last runs: listed ${++listed} of ${projects.length} projects`);
    }
  });

  // Read launches that are new or were still open last time.
  const doneLaunch = d.prepare("select done from run_launch where id = ?");
  const todo = launches.filter(({ launch }) => (doneLaunch.get(launch.id) as { done: number } | undefined)?.done !== 1);
  const saveLaunch = d.prepare(
    "insert into run_launch (id, project_id, created, done) values (?, ?, ?, ?) on conflict (id) do update set done = excluded.done",
  );
  const markRun = d.prepare(`
    insert into tc_run (tc_id, last_run, ever_run) values (?, ?, 1)
    on conflict (tc_id) do update set last_run = max(coalesce(tc_run.last_run, 0), excluded.last_run), ever_run = 1
  `);
  // A launch that fails to read is simply read again next time.
  let read = 0;
  let attempted = 0;
  await mapLimit(todo, 4, async ({ launch, projectId }) => {
    try {
      const rows = await client.all<ApiTestResultRow>("/api/rs/testresult/__search", {
        projectId: String(projectId),
        rql: `launch = ${launch.id} and ${FINISHED}`,
        sort: "testCaseId,asc",
      });
      const created = launch.createdDate ?? Date.now();
      tx(d, () => {
        for (const id of new Set(rows.map((r) => r.testCaseId).filter((id): id is number => typeof id === "number"))) markRun.run(id, created);
        saveLaunch.run(launch.id, projectId, created, launch.closed ? 1 : 0);
      });
      read++;
    } catch {
      // retried on the next refresh
    }
    if (++attempted % 10 === 0 || attempted === todo.length) report(`Last runs: read ${attempted} of ${todo.length} launches`);
  });

  // Test cases never seen in a launch are checked for any finished result,
  // a chunk at a time; a chunk with results is split until each test case is
  // known. A test case that ran once stays known as run.
  const runOf = d.prepare("select last_run, ever_run from tc_run where tc_id = ?");
  const setEver = d.prepare(
    "insert into tc_run (tc_id, last_run, ever_run) values (?, null, ?) on conflict (tc_id) do update set ever_run = excluded.ever_run",
  );
  const unknown = new Map<number, number[]>();
  for (const tc of testCases) {
    const run = runOf.get(tc.id) as { last_run: number | null; ever_run: number | null } | undefined;
    if (run?.ever_run === 1 || run?.ever_run === 0) continue;
    if (!unknown.has(tc.projectId)) unknown.set(tc.projectId, []);
    unknown.get(tc.projectId)!.push(tc.id);
  }
  const total = [...unknown.values()].reduce((n, ids) => n + ids.length, 0);
  let checked = 0;
  const check = async (projectId: number, ids: number[]): Promise<void> => {
    const { count } = await client.get<{ count: number }>("/api/rs/testresult/query/validate", {
      projectId: String(projectId),
      rql: `testCaseId in [${ids.join(",")}] and ${FINISHED}`,
    });
    if (count === 0 || ids.length === 1) {
      tx(d, () => ids.forEach((id) => setEver.run(id, count > 0 ? 1 : 0)));
      checked += ids.length;
      report(`Last runs: checked ${checked} of ${total} test cases for any run`);
      return;
    }
    const half = Math.ceil(ids.length / 2);
    await Promise.all([check(projectId, ids.slice(0, half)), check(projectId, ids.slice(half))]);
  };
  const chunks = [...unknown].flatMap(([projectId, ids]) =>
    Array.from({ length: Math.ceil(ids.length / NEVER_RUN_CHUNK) }, (_, i) => ({ projectId, ids: ids.slice(i * NEVER_RUN_CHUNK, (i + 1) * NEVER_RUN_CHUNK) })),
  );
  await mapLimit(chunks, 4, ({ projectId, ids }) => check(projectId, ids).catch(() => undefined));

  for (const tc of testCases) {
    const run = runOf.get(tc.id) as { last_run: number | null; ever_run: number | null } | undefined;
    tc.lastRun = run?.last_run ?? null;
    tc.everRun = run?.ever_run === 1 ? true : run?.ever_run === 0 ? false : null;
  }

  return {
    endpoint: client.endpoint,
    projects: projects.map((p) => ({ id: p.id, name: p.name })),
    failedProjects,
    lookbackDays: LOOKBACK_DAYS,
    testCases,
    sync: { launchesRead: read, neverRunChecked: checked },
  };
}

export interface WorkflowInfo {
  id: number;
  name: string;
  statuses: { id: number; name: string; color: string | null }[];
}

/** All workflows with their statuses; the list carries the statuses, a workflow without them is asked for separately. */
export async function workflows(client: TestOpsClient): Promise<WorkflowInfo[]> {
  const list = await client.all<ApiNamed & { statuses?: ApiNamed[] | null }>("/api/rs/workflow", { sort: "name,asc" });
  const toInfo = (w: ApiNamed & { statuses?: ApiNamed[] | null }): WorkflowInfo => ({
    id: w.id,
    name: w.name,
    statuses: (w.statuses ?? []).map((s) => ({ id: s.id, name: s.name, color: s.color ?? null })),
  });
  return mapLimit(list, 4, async (w) => {
    if (w.statuses && w.statuses.length > 0) return toInfo(w);
    const full = await client.get<ApiNamed & { statuses?: ApiNamed[] | null }>(`/api/rs/workflow/${w.id}`).catch(() => w);
    return toInfo(full);
  });
}

export interface ApplyResult {
  projectId: number;
  count: number;
  error: string | null;
}

const APPLY_CHUNK = 500;

/** Sets workflow and status on test cases, one bulk call per project and chunk. */
export async function applyStatus(
  client: TestOpsClient,
  byProject: Map<number, number[]>,
  workflowId: number,
  statusId: number,
): Promise<ApplyResult[]> {
  return mapLimit([...byProject], 2, async ([projectId, ids]) => {
    let done = 0;
    try {
      for (let i = 0; i < ids.length; i += APPLY_CHUNK) {
        const chunk = ids.slice(i, i + APPLY_CHUNK);
        await client.post("/api/rs/testcase/bulk/status/set", {
          selection: { projectId, inverted: false, leafsInclude: chunk, search: "" },
          workflowId,
          statusId,
        });
        done += chunk.length;
      }
      return { projectId, count: done, error: null };
    } catch (e) {
      return { projectId, count: done, error: e instanceof Error ? e.message : String(e) };
    }
  });
}
