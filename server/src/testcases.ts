import { database, defineTables, getMeta, setMeta, tx } from "./db.js";
import { mapLimit } from "./pool.js";
import type { Project } from "./collect.js";
import type { TestOpsClient } from "./testops.js";

interface ApiTestCaseRow {
  id: number;
  name: string;
  lastModifiedDate?: number | null;
  automated?: boolean | null;
}

interface ApiTestCaseOverview {
  id: number;
  name: string;
  automated?: boolean | null;
  layer?: { id: number; name: string } | null;
  tags?: { id: number; name: string }[] | null;
  issues?: { id: number; name: string; url?: string | null }[] | null;
  customFields?: { id: number; name: string; customField?: { id: number; name: string } | null }[] | null;
  members?: { id: number; name: string; role?: { id: number; name: string } | null }[] | null;
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
  issues: { name: string; url: string | null }[];
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

type Report = (progress: string) => void;

const DETAILS_IN_PARALLEL = 8;

function toTestCase(row: ApiTestCaseRow, projectId: number, o: ApiTestCaseOverview | null): TestCase {
  const customFields = new Map<string, string[]>();
  for (const v of o?.customFields ?? []) {
    const field = v.customField?.name;
    if (!field) continue;
    if (!customFields.has(field)) customFields.set(field, []);
    customFields.get(field)!.push(v.name);
  }
  return {
    id: row.id,
    name: o?.name ?? row.name,
    projectId,
    detailed: o !== null,
    modified: row.lastModifiedDate ?? null,
    automated: row.automated ?? o?.automated ?? null,
    layer: o?.layer?.name ?? null,
    tags: (o?.tags ?? []).map((t) => t.name),
    issues: (o?.issues ?? []).map((i) => ({ name: i.name, url: i.url ?? null })),
    members: (o?.members ?? []).map((m) => ({ role: m.role?.name ?? "", name: m.name })),
    customFields: [...customFields].map(([name, values]) => ({ name, values })),
  };
}

/** A full reload also picks up changes that do not move the modification date. */
const FULL_RELOAD_EVERY_MS = 24 * 3_600_000;
const FULL_RELOAD_KEY = "testcases.fullReloadAt";

defineTables(
  `
    create table if not exists testcase (
      id integer primary key,
      project_id integer not null,
      -- the test case as the application shows it, JSON
      data text not null
    );
  `,
  ["testcase"],
);

let fullReloadRequested = false;

/** The next crawl reloads the details of every test case. */
export function requestFullReload(requested = true): void {
  fullReloadRequested = requested;
}

/**
 * All test cases of all projects. Details are requested only for new test
 * cases and those whose modification date changed; the rest come from the
 * test case table, which is updated row by row.
 */
export async function collectTestCases(client: TestOpsClient, report: Report): Promise<TestCasesData> {
  const d = database(client.endpoint);
  const lastFullReload = Number(getMeta(d, FULL_RELOAD_KEY) ?? 0);
  const cached = new Map(
    (d.prepare("select data from testcase").all() as { data: string }[]).map((r) => {
      const tc = JSON.parse(r.data) as TestCase;
      return [tc.id, tc];
    }),
  );
  const full = fullReloadRequested || cached.size === 0 || Date.now() - lastFullReload >= FULL_RELOAD_EVERY_MS;
  fullReloadRequested = false;

  report("Loading projects");
  const projects = await client.projects();
  const failedProjects: TestCasesData["failedProjects"] = [];

  const rows: { row: ApiTestCaseRow; projectId: number }[] = [];
  const kept: TestCase[] = [];
  let listed = 0;
  await mapLimit(projects, 4, async (p) => {
    try {
      const list = await client.all<ApiTestCaseRow>("/api/rs/testcase/__search", {
        projectId: String(p.id),
        rql: "true",
        sort: "id,asc",
      });
      rows.push(...list.map((row) => ({ row, projectId: p.id })));
    } catch (e) {
      failedProjects.push({ id: p.id, error: e instanceof Error ? e.message : String(e) });
      // A project that failed to list keeps its cached test cases.
      kept.push(...[...cached.values()].filter((tc) => tc.projectId === p.id));
    } finally {
      report(`Test cases: listed ${++listed} of ${projects.length} projects`);
    }
  });

  const stale = rows.filter(({ row, projectId }) => {
    const tc = cached.get(row.id);
    return full || !tc || !tc.detailed || tc.projectId !== projectId || tc.modified !== (row.lastModifiedDate ?? null);
  });
  const staleIds = new Set(stale.map(({ row }) => row.id));

  let done = 0;
  const loaded = await mapLimit(stale, DETAILS_IN_PARALLEL, async ({ row, projectId }) => {
    const overview = await client.get<ApiTestCaseOverview>(`/api/rs/testcase/${row.id}/overview`).catch(() => null);
    if (++done % 50 === 0 || done === stale.length) report(`Test cases: details loaded for ${done} of ${stale.length} new or changed`);
    return toTestCase(row, projectId, overview);
  });

  // The list carries the automation flag, so cached test cases get it fresh.
  const reused = rows
    .filter(({ row }) => !staleIds.has(row.id))
    .map(({ row }) => {
      const tc = cached.get(row.id)!;
      return { ...tc, automated: row.automated ?? tc.automated ?? null };
    });
  const testCases = [...reused, ...loaded, ...kept].sort((a, b) => a.projectId - b.projectId || a.id - b.id);
  const present = new Set(testCases.map((tc) => tc.id));
  const fullReloadAt = full ? Date.now() : lastFullReload;

  // Only new, changed and removed test cases touch the table.
  const upsert = d.prepare("insert or replace into testcase (id, project_id, data) values (?, ?, ?)");
  const remove = d.prepare("delete from testcase where id = ?");
  tx(d, () => {
    for (const tc of loaded) upsert.run(tc.id, tc.projectId, JSON.stringify(tc));
    for (const tc of reused) {
      if (tc.automated !== cached.get(tc.id)?.automated) upsert.run(tc.id, tc.projectId, JSON.stringify(tc));
    }
    for (const id of cached.keys()) if (!present.has(id)) remove.run(id);
    setMeta(d, FULL_RELOAD_KEY, String(fullReloadAt));
  });

  return {
    endpoint: client.endpoint,
    projects: projects.map((p) => ({ id: p.id, name: p.name })),
    failedProjects,
    testCases,
    sync: {
      full,
      loaded: loaded.length,
      reused: reused.length + kept.length,
      removed: [...cached.keys()].filter((id) => !present.has(id)).length,
      fullReloadAt,
    },
  };
}
