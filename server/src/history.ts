import type { DatabaseSync } from "node:sqlite";
import type { Project } from "./collect.js";
import { database, defineTables, tx } from "./db.js";
import { mapLimit } from "./pool.js";
import type { TestOpsClient } from "./testops.js";

/**
 * Automation history of test cases, rebuilt from their change logs and kept
 * in SQLite next to the other data. A change log is loaded once per test case
 * and again only when its automation or deletion state is seen to change.
 */

interface ApiTestCase {
  id: number;
  projectId?: number;
  createdDate?: number | null;
  automated?: boolean | null;
}

interface ApiChangeLogEntry {
  timestamp: number;
  actionType?: string;
  data?: { type?: string; diff?: Record<string, { oldValue?: unknown; newValue?: unknown }> }[] | null;
}

/** [time, "a" for automated or "d" for deleted, 1 or 0] */
export type HistoryEvent = [number, "a" | "d", 0 | 1];

export interface TestCaseHistory {
  id: number;
  projectId: number;
  created: number | null;
  /** Automation state before the first recorded change; null when unknown. */
  initial: 0 | 1 | null;
  events: HistoryEvent[];
}

export interface HistoryData {
  endpoint: string;
  projects: Project[];
  failedProjects: { id: number; error: string }[];
  testCases: TestCaseHistory[];
  sync: { changeLogsLoaded: number; changeLogsPending: number; changeLogsFailed: number; disappeared: number };
}

type Report = (progress: string) => void;

const CHANGE_LOGS_IN_PARALLEL = 8;

defineTables(
  `
    create table if not exists tc (
      id integer primary key,
      project_id integer not null,
      created integer,
      automated integer,
      deleted integer not null default 0,
      -- no longer listed at all, e.g. deleted for good
      gone integer not null default 0,
      -- change log loaded
      loaded integer not null default 0,
      initial integer
    );
    create table if not exists event (
      tc_id integer not null,
      ts integer not null,
      kind text not null,
      value integer not null,
      -- "log": from the change log, "seen": noticed by this application
      source text not null,
      primary key (tc_id, ts, kind, value)
    );
  `,
  ["event", "tc"],
);

const bit = (v: unknown): 0 | 1 | null => (v === true ? 1 : v === false ? 0 : null);

/** Events and the initial automation state from a change log, oldest first. */
function parseChangeLog(entries: ApiChangeLogEntry[], current: 0 | 1 | null) {
  const events: HistoryEvent[] = [];
  let initial: 0 | 1 | null | undefined;
  let createdAt: number | null = null;
  for (const e of [...entries].sort((a, b) => a.timestamp - b.timestamp)) {
    for (const item of e.data ?? []) {
      if (item.type !== "test_case" || !item.diff) continue;
      if (e.actionType === "insert" && createdAt === null) createdAt = e.timestamp;
      const automated = item.diff.automated;
      if (automated && "newValue" in automated) {
        const value = bit(automated.newValue);
        if (initial === undefined) initial = "oldValue" in automated ? bit(automated.oldValue) : value;
        if (value !== null) events.push([e.timestamp, "a", value]);
      }
      const deleted = item.diff.deleted;
      if (deleted && "newValue" in deleted) {
        const value = bit(deleted.newValue);
        if (value !== null) events.push([e.timestamp, "d", value]);
      }
    }
  }
  return { events, initial: initial === undefined ? current : initial, createdAt };
}

export async function collectHistory(client: TestOpsClient, report: Report): Promise<HistoryData> {
  const d = database(client.endpoint);
  report("Loading projects");
  const projects = await client.projects();
  const failedProjects: HistoryData["failedProjects"] = [];

  const listed: { tc: ApiTestCase; projectId: number; deleted: 0 | 1 }[] = [];
  const listedProjects = new Set<number>();
  let done = 0;
  await mapLimit(projects, 4, async (p) => {
    try {
      const params = { projectId: String(p.id), rql: "true", sort: "id,asc" };
      const [active, removed] = await Promise.all([
        client.all<ApiTestCase>("/api/rs/testcase/__search", { ...params, deleted: "false" }),
        client.all<ApiTestCase>("/api/rs/testcase/__search", { ...params, deleted: "true" }),
      ]);
      listed.push(...active.map((tc) => ({ tc, projectId: p.id, deleted: 0 as const })));
      listed.push(...removed.map((tc) => ({ tc, projectId: p.id, deleted: 1 as const })));
      listedProjects.add(p.id);
    } catch (e) {
      failedProjects.push({ id: p.id, error: e instanceof Error ? e.message : String(e) });
    } finally {
      report(`Automation history: listed ${++done} of ${projects.length} projects`);
    }
  });

  // Decide whose change log to (re)load and remember the current state.
  const select = d.prepare("select automated, deleted, gone, loaded from tc where id = ?");
  const upsert = d.prepare(`
    insert into tc (id, project_id, created, automated, deleted, gone) values (?, ?, ?, ?, ?, 0)
    on conflict (id) do update set project_id = excluded.project_id, created = coalesce(excluded.created, tc.created),
      automated = excluded.automated, deleted = excluded.deleted, gone = 0
  `);
  const addEvent = d.prepare("insert or ignore into event (tc_id, ts, kind, value, source) values (?, ?, ?, ?, ?)");
  const stale: { id: number; automated: 0 | 1 | null }[] = [];
  const seen = new Set<number>();
  let disappeared = 0;
  tx(d, () => {
    for (const { tc, projectId, deleted } of listed) {
      if (seen.has(tc.id)) continue;
      seen.add(tc.id);
      const automated = bit(tc.automated);
      const known = select.get(tc.id) as { automated: number | null; deleted: number; gone: number; loaded: number } | undefined;
      if (!known || !known.loaded || known.automated !== automated || known.deleted !== deleted || known.gone) {
        stale.push({ id: tc.id, automated });
      }
      upsert.run(tc.id, projectId, tc.createdDate ?? null, automated, deleted);
    }

    // Test cases of successfully listed projects that are not listed at all any
    // more were deleted for good; their change log is gone with them.
    const now = Date.now();
    const missing = d.prepare("select id, project_id from tc where gone = 0").all() as { id: number; project_id: number }[];
    const markGone = d.prepare("update tc set gone = 1 where id = ?");
    for (const m of missing) {
      if (seen.has(m.id) || !listedProjects.has(m.project_id)) continue;
      markGone.run(m.id);
      addEvent.run(m.id, now, "d", 1, "seen");
      disappeared++;
    }
  });

  let loaded = 0;
  let failed = 0;
  const clearLog = d.prepare("delete from event where tc_id = ? and source = 'log'");
  const setLoaded = d.prepare("update tc set loaded = 1, initial = ?, created = coalesce(created, ?) where id = ?");
  await mapLimit(stale, CHANGE_LOGS_IN_PARALLEL, async ({ id, automated }) => {
    try {
      const entries = await client.all<ApiChangeLogEntry>("/api/rs/testcase/audit", { testCaseId: String(id) });
      const log = parseChangeLog(entries, automated);
      tx(d, () => {
        clearLog.run(id);
        for (const [ts, kind, value] of log.events) addEvent.run(id, ts, kind, value, "log");
        setLoaded.run(log.initial, log.createdAt, id);
      });
      loaded++;
    } catch {
      failed++;
    }
    const n = loaded + failed;
    if (n % 50 === 0 || n === stale.length) report(`Automation history: change logs loaded for ${n} of ${stale.length}`);
  });

  return {
    endpoint: client.endpoint,
    projects: projects.map((p) => ({ id: p.id, name: p.name })),
    failedProjects,
    testCases: readHistory(d),
    sync: {
      changeLogsLoaded: loaded,
      changeLogsFailed: failed,
      changeLogsPending: (d.prepare("select count(*) as n from tc where loaded = 0 and gone = 0").get() as { n: number }).n,
      disappeared,
    },
  };
}

function readHistory(d: DatabaseSync): TestCaseHistory[] {
  const byId = new Map<number, TestCaseHistory>();
  const rows = d.prepare("select id, project_id, created, automated, initial from tc").all() as {
    id: number;
    project_id: number;
    created: number | null;
    automated: number | null;
    initial: number | null;
  }[];
  for (const r of rows) {
    const initial = r.initial ?? r.automated;
    byId.set(r.id, {
      id: r.id,
      projectId: r.project_id,
      created: r.created,
      initial: initial === 1 ? 1 : initial === 0 ? 0 : null,
      events: [],
    });
  }
  const events = d.prepare("select tc_id, ts, kind, value from event order by tc_id, ts").all() as {
    tc_id: number;
    ts: number;
    kind: "a" | "d";
    value: number;
  }[];
  for (const e of events) byId.get(e.tc_id)?.events.push([e.ts, e.kind, e.value === 1 ? 1 : 0]);
  return [...byId.values()];
}
