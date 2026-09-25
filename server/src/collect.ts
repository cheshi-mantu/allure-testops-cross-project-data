import { mapLimit } from "./pool.js";
import type { ApiDefectMatcher, ApiLaunch, ApiProject, ApiStatusCount, TestOpsClient } from "./testops.js";

export interface Project {
  id: number;
  name: string;
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
  env: { name: string; value: string }[];
  /** null when the counts could not be loaded. */
  statistic: LaunchStatistic | null;
  unresolved: number | null;
  muted: number | null;
  newDefects: number | null;
  knownDefects: number | null;
}

export interface Defect {
  id: number;
  name: string;
  projectId: number;
  closed: boolean;
  createdBy: string | null;
  /** Where `createdBy` comes from: the API has no defect creator, the first matcher's author stands in. */
  creatorSource: "defect" | "matcher" | null;
  createdDate: number | null;
  issues: { name: string; url: string | null }[];
  /** null when the matchers could not be loaded. */
  matchers: { id: number; name: string; messageRegex: string | null; traceRegex: string | null }[] | null;
  testCases: number | null;
  testResults: number | null;
  launches: number | null;
}

interface Collected<T> {
  endpoint: string;
  projects: Project[];
  failedProjects: { id: number; error: string }[];
  items: T[];
}

export interface LaunchesData extends Omit<Collected<Launch>, "items"> {
  launches: Launch[];
  closedLaunchesDays: number;
}

export interface DefectsData extends Omit<Collected<Defect>, "items"> {
  defects: Defect[];
}

type Report = (progress: string) => void;

const PROJECTS_IN_PARALLEL = 4;

/**
 * Walks all projects; one failing project does not spoil the whole crawl, it
 * is reported in `failedProjects` instead.
 */
async function perProject<T>(
  client: TestOpsClient,
  report: Report,
  what: string,
  load: (project: ApiProject) => Promise<T[]>,
): Promise<Collected<T>> {
  report("Loading projects");
  const projects = await client.projects();
  const failedProjects: Collected<T>["failedProjects"] = [];
  let done = 0;
  const chunks = await mapLimit(projects, PROJECTS_IN_PARALLEL, async (p) => {
    try {
      return await load(p);
    } catch (e) {
      failedProjects.push({ id: p.id, error: e instanceof Error ? e.message : String(e) });
      return [];
    } finally {
      report(`${what}: ${++done} of ${projects.length} projects processed`);
    }
  });
  return {
    endpoint: client.endpoint,
    projects: projects.map((p) => ({ id: p.id, name: p.name })),
    failedProjects,
    items: chunks.flat(),
  };
}

/** Closed launches are looked at this far back. */
export const CLOSED_LAUNCHES_DAYS = 30;
const LAUNCH_DETAILS_IN_PARALLEL = 8;

function toStatistic(counts: ApiStatusCount[]): LaunchStatistic {
  const s: LaunchStatistic = { passed: 0, failed: 0, broken: 0, skipped: 0, unknown: 0, inProgress: 0 };
  for (const { status, count } of counts) {
    if (status === null) s.inProgress += count;
    else if (status in s && status !== "inProgress") s[status as keyof LaunchStatistic] += count;
    else s.unknown += count;
  }
  return s;
}

function toLaunch(l: ApiLaunch, projectId: number): Launch {
  return {
    id: l.id,
    name: l.name,
    projectId: l.projectId ?? projectId,
    closed: Boolean(l.closed),
    createdBy: l.createdBy ?? null,
    createdDate: l.createdDate ?? null,
    tags: (l.tags ?? []).map((t) => t.name),
    env: (l.environment ?? []).map((e) => ({ name: e.variable?.name ?? "", value: e.name })),
    statistic: l.statistic ? toStatistic(l.statistic) : null,
    unresolved: null,
    muted: null,
    newDefects: l.newDefectsCount ?? null,
    knownDefects: l.knownDefectsCount ?? null,
  };
}

/**
 * Open launches, plus closed launches of the last CLOSED_LAUNCHES_DAYS that
 * still have unresolved results.
 */
export async function collectLaunches(client: TestOpsClient, report: Report): Promise<LaunchesData> {
  const since = Date.now() - CLOSED_LAUNCHES_DAYS * 86_400_000;
  const { items, ...rest } = await perProject(client, report, "Launches", async (p) => {
    const [open, closed] = await Promise.all([client.openLaunches(p.id), client.closedLaunchesSince(p.id, since)]);
    return [...open, ...closed].map((l) => toLaunch(l, p.id));
  });

  // Unresolved and muted counts, and the statistic when the list has none,
  // are requested per launch. A closed launch without unresolved results is
  // dropped before its other counts are requested.
  let done = 0;
  const settled = <T>(r: PromiseSettledResult<T>) => (r.status === "fulfilled" ? r.value : null);
  const kept = await mapLimit(items, LAUNCH_DETAILS_IN_PARALLEL, async (l) => {
    try {
      l.unresolved = await client.count(`/api/rs/launch/${l.id}/unresolved`).catch(() => null);
      if (l.closed && l.unresolved === 0) return null;
      const [muted, statistic] = await Promise.allSettled([
        client.count(`/api/rs/launch/${l.id}/muted`),
        l.statistic ?? client.launchStatistic(l.id).then(toStatistic),
      ]);
      l.muted = settled(muted);
      l.statistic = settled(statistic);
      return l;
    } finally {
      if (++done % 25 === 0 || done === items.length) {
        report(`Launches: details collected for ${done} of ${items.length}`);
      }
    }
  });

  return { ...rest, launches: kept.filter((l): l is Launch => l !== null), closedLaunchesDays: CLOSED_LAUNCHES_DAYS };
}

const DEFECT_COUNTS_IN_PARALLEL = 8;

/** Author of the earliest matcher: usually added by whoever filed the defect. */
function firstMatcherAuthor(matchers: ApiDefectMatcher[]): string | null {
  const withAuthor = matchers.filter((m) => m.createdBy);
  withAuthor.sort((a, b) => (a.createdDate ?? Infinity) - (b.createdDate ?? Infinity) || a.id - b.id);
  return withAuthor[0]?.createdBy ?? null;
}

export async function collectDefects(client: TestOpsClient, report: Report): Promise<DefectsData> {
  const { items, ...rest } = await perProject(client, report, "Defects", async (p) => {
    const rows = await client.defects(p.id);
    return rows.map(
      (d): Defect => ({
        id: d.id,
        name: d.name,
        projectId: p.id,
        closed: Boolean(d.closed),
        createdBy: d.createdBy ?? null,
        creatorSource: d.createdBy ? "defect" : null,
        createdDate: d.createdDate ?? null,
        issues: d.issue ? [{ name: d.issue.name, url: d.issue.url ?? null }] : [],
        matchers: null,
        testCases: d.count ?? null,
        testResults: null,
        launches: null,
      }),
    );
  });

  // Matchers, result and launch counts are requested per defect: three small
  // requests each. The test case count usually comes with the list; a
  // separate request covers the case when it does not.
  let done = 0;
  const settled = (r: PromiseSettledResult<number>) => (r.status === "fulfilled" ? r.value : null);
  await mapLimit(items, DEFECT_COUNTS_IN_PARALLEL, async (d) => {
    const [results, launches, testCases, matchers] = await Promise.allSettled([
      client.count(`/api/rs/defect/${d.id}/testresult`),
      client.count(`/api/rs/defect/${d.id}/launch`),
      d.testCases ?? client.count(`/api/rs/defect/${d.id}/testcase`),
      client.all<ApiDefectMatcher>(`/api/rs/defect/${d.id}/matcher`, { sort: "id,asc" }),
    ]);
    d.testResults = settled(results);
    d.launches = settled(launches);
    d.testCases = settled(testCases);
    d.matchers =
      matchers.status === "fulfilled"
        ? matchers.value.map((m) => ({
            id: m.id,
            name: m.name,
            messageRegex: m.messageRegex || null,
            traceRegex: m.traceRegex || null,
          }))
        : null;
    if (!d.createdBy && matchers.status === "fulfilled") {
      const author = firstMatcherAuthor(matchers.value);
      if (author) {
        d.createdBy = author;
        d.creatorSource = "matcher";
      }
    }
    if (++done % 25 === 0 || done === items.length) {
      report(`Defects: details collected for ${done} of ${items.length}`);
    }
  });

  return { ...rest, defects: items };
}
