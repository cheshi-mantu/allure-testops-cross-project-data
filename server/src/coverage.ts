import type { Project } from "./collect.js";
import { database, defineTables, tx } from "./db.js";
import { JiraClient, syncJiraIssues, type JiraIssue, type JiraScope, type JiraSync } from "./jira.js";
import { mapLimit } from "./pool.js";
import type { TestOpsClient } from "./testops.js";

/**
 * How Jira issues are covered by Allure TestOps test cases, launches and
 * defects. An issue link counts when its name equals the Jira issue key.
 */

interface ApiIssueLink {
  name?: string | null;
}

interface ApiLinkedTestCase {
  id: number;
  name: string;
  lastModifiedDate?: number | null;
}

interface ApiLinkedLaunch {
  id: number;
  name: string;
  closed?: boolean;
  createdDate?: number | null;
  issues?: ApiIssueLink[] | null;
}

interface ApiDefectRow {
  id: number;
  name: string;
  closed?: boolean;
  issue?: ApiIssueLink | null;
}

export interface LinkedEntity {
  id: number;
  name: string;
  projectId: number;
  closed?: boolean;
}

export interface CoverageData {
  endpoint: string;
  jiraUrl: string;
  /** Jira projects in scope, for their names. */
  jiraProjects: { key: string; name: string }[];
  projects: Project[];
  failedProjects: { id: number; error: string }[];
  issues: JiraIssue[];
  /** Linked entities per Jira issue key; only keys of loaded Jira issues. */
  testCases: Record<string, LinkedEntity[]>;
  launches: Record<string, LinkedEntity[]>;
  defects: Record<string, LinkedEntity[]>;
  sync: JiraSync & { testCaseLinksLoaded: number };
}

type Report = (progress: string) => void;

defineTables(
  `
    -- issue keys of test cases, valid while the modification date is the same
    create table if not exists tc_issue (
      tc_id integer primary key,
      modified integer,
      keys text not null
    );
  `,
  ["tc_issue"],
);

function add(map: Record<string, LinkedEntity[]>, keys: Iterable<string>, known: Set<string>, entity: LinkedEntity) {
  for (const key of new Set(keys)) {
    if (!known.has(key)) continue;
    (map[key] ??= []).push(entity);
  }
}

export async function collectCoverage(
  client: TestOpsClient,
  jira: JiraClient | null,
  scope: JiraScope,
  report: Report,
): Promise<CoverageData> {
  if (!jira) throw new Error("Jira is not configured: set it up on the Settings tab");
  const { issues, sync } = await syncJiraIssues(client.endpoint, jira, scope, report);
  const jiraProjects = (await jira.projects()).filter((p) => scope.projects.includes(p.key)).map((p) => ({ key: p.key, name: p.name }));
  const known = new Set(issues.map((i) => i.key));

  report("Loading projects");
  const projects = await client.projects();
  const failedProjects: CoverageData["failedProjects"] = [];
  const testCases: CoverageData["testCases"] = {};
  const launches: CoverageData["launches"] = {};
  const defects: CoverageData["defects"] = {};

  const d = database(client.endpoint);
  const cachedKeys = d.prepare("select modified, keys from tc_issue where tc_id = ?");
  const saveKeys = d.prepare("insert or replace into tc_issue (tc_id, modified, keys) values (?, ?, ?)");
  let testCaseLinksLoaded = 0;
  let done = 0;

  await mapLimit(projects, 4, async (p) => {
    try {
      const withIssue = { projectId: String(p.id), rql: "issue != null", sort: "id,asc" };
      const [linkedCases, linkedLaunches, defectRows] = await Promise.all([
        client.all<ApiLinkedTestCase>("/api/rs/testcase/__search", withIssue),
        client.all<ApiLinkedLaunch>("/api/rs/launch/__search", withIssue),
        client.all<ApiDefectRow>("/api/rs/defect", { projectId: String(p.id), sort: "id,asc" }),
      ]);

      // Issue keys of a test case are reloaded only when it changed.
      await mapLimit(linkedCases, 8, async (tc) => {
        const modified = tc.lastModifiedDate ?? null;
        const row = cachedKeys.get(tc.id) as { modified: number | null; keys: string } | undefined;
        let keys: string[];
        if (row && row.modified === modified) {
          keys = JSON.parse(row.keys) as string[];
        } else {
          const links = await client.get<ApiIssueLink[]>(`/api/rs/testcase/${tc.id}/issue`);
          keys = links.map((l) => l.name ?? "").filter(Boolean);
          tx(d, () => saveKeys.run(tc.id, modified, JSON.stringify(keys)));
          testCaseLinksLoaded++;
        }
        add(testCases, keys, known, { id: tc.id, name: tc.name, projectId: p.id });
      });

      for (const l of linkedLaunches) {
        add(
          launches,
          (l.issues ?? []).map((i) => i.name ?? ""),
          known,
          { id: l.id, name: l.name, projectId: p.id, closed: Boolean(l.closed) },
        );
      }
      for (const df of defectRows) {
        if (df.issue?.name) add(defects, [df.issue.name], known, { id: df.id, name: df.name, projectId: p.id, closed: Boolean(df.closed) });
      }
    } catch (e) {
      failedProjects.push({ id: p.id, error: e instanceof Error ? e.message : String(e) });
    } finally {
      report(`Allure TestOps links: ${++done} of ${projects.length} projects processed`);
    }
  });

  return {
    endpoint: client.endpoint,
    jiraUrl: jira.url,
    jiraProjects,
    projects: projects.map((p) => ({ id: p.id, name: p.name })),
    failedProjects,
    issues,
    testCases,
    launches,
    defects,
    sync: { ...sync, testCaseLinksLoaded },
  };
}
