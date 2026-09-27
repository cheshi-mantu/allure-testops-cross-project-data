import { database, defineTables, getMeta, setMeta, tx } from "./db.js";

/**
 * Jira Cloud REST API v3 client and the issue store. Issues of the chosen
 * projects and types are loaded in full once, then only those updated since
 * the last load; a daily full load drops deleted and moved issues.
 */

const REQUEST_TIMEOUT_MS = 60_000;
const PAGE_SIZE = 100;
const FULL_SYNC_EVERY_MS = 24 * 3_600_000;
/** Extra minutes on each delta, against clock differences and slow indexing. */
const DELTA_OVERLAP_MIN = 60;

export interface JiraCredentials {
  url: string;
  email: string;
  token: string;
}

export interface JiraProject {
  key: string;
  name: string;
  issueTypes: string[];
}

export interface JiraIssue {
  key: string;
  summary: string;
  type: string;
  status: string;
  /** "new", "indeterminate" or "done". */
  statusCategory: string;
  project: string;
  updated: number | null;
}

export class JiraError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export class JiraClient {
  constructor(private readonly c: JiraCredentials) {}

  get url(): string {
    return this.c.url;
  }

  private async request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const url = new URL(this.c.url + path);
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: {
          Authorization: `Basic ${Buffer.from(`${this.c.email}:${this.c.token}`).toString("base64")}`,
          Accept: "application/json",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (e) {
      const cause = e instanceof Error && e.cause instanceof Error ? e.cause.message : e instanceof Error ? e.message : String(e);
      throw new JiraError(`Cannot reach ${url.origin}: ${cause}`);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      let detail = text.slice(0, 200);
      try {
        const parsed = JSON.parse(text) as { errorMessages?: string[]; message?: string };
        detail = parsed.errorMessages?.join("; ") || parsed.message || detail;
      } catch {
        // keep the raw text
      }
      throw new JiraError(`Jira ${res.status} ${res.statusText} for ${method} ${url.pathname}${detail ? `: ${detail}` : ""}`, res.status);
    }
    return (await res.json()) as T;
  }

  async myself(): Promise<{ displayName: string; emailAddress?: string }> {
    return this.request("GET", "/rest/api/3/myself");
  }

  async projects(): Promise<JiraProject[]> {
    const result: JiraProject[] = [];
    for (let startAt = 0; ; startAt += 50) {
      const page = await this.request<{
        values: { key: string; name: string; issueTypes?: { name: string; subtask?: boolean }[] }[];
        isLast?: boolean;
      }>("GET", `/rest/api/3/project/search?startAt=${startAt}&maxResults=50&expand=issueTypes&orderBy=key`);
      for (const p of page.values) {
        result.push({ key: p.key, name: p.name, issueTypes: [...new Set((p.issueTypes ?? []).map((t) => t.name))] });
      }
      if (page.isLast !== false || page.values.length === 0) return result;
    }
  }

  /** All issues matching `jql`, following the token-based pagination of the JQL search. */
  async search(jql: string, onPage?: (loaded: number) => void): Promise<JiraIssue[]> {
    const issues: JiraIssue[] = [];
    let nextPageToken: string | undefined;
    do {
      const page = await this.request<{
        issues: {
          key: string;
          fields: {
            summary?: string;
            issuetype?: { name?: string };
            status?: { name?: string; statusCategory?: { key?: string } };
            project?: { key?: string };
            updated?: string;
          };
        }[];
        nextPageToken?: string;
      }>("POST", "/rest/api/3/search/jql", {
        jql,
        fields: ["summary", "issuetype", "status", "project", "updated"],
        maxResults: PAGE_SIZE,
        ...(nextPageToken ? { nextPageToken } : {}),
      });
      for (const i of page.issues) {
        issues.push({
          key: i.key,
          summary: i.fields.summary ?? "",
          type: i.fields.issuetype?.name ?? "",
          status: i.fields.status?.name ?? "",
          statusCategory: i.fields.status?.statusCategory?.key ?? "",
          project: i.fields.project?.key ?? i.key.split("-")[0],
          updated: i.fields.updated ? Date.parse(i.fields.updated) : null,
        });
      }
      onPage?.(issues.length);
      nextPageToken = page.nextPageToken;
    } while (nextPageToken);
    return issues;
  }
}

defineTables(
  `
    create table if not exists jira_issue (
      key text primary key,
      project text not null,
      -- the issue as the application shows it, JSON
      data text not null
    );
  `,
  ["jira_issue"],
);

const quote = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

export interface JiraScope {
  projects: string[];
  issueTypes: string[];
}

export interface JiraSync {
  full: boolean;
  loaded: number;
  total: number;
}

/**
 * Brings the stored issues up to date and returns them. The store belongs to
 * the Allure TestOps instance's database; a change of Jira site, projects or
 * issue types starts it over.
 */
export async function syncJiraIssues(
  endpoint: string,
  jira: JiraClient,
  scope: JiraScope,
  report: (progress: string) => void,
): Promise<{ issues: JiraIssue[]; sync: JiraSync }> {
  const d = database(endpoint);
  const signature = JSON.stringify({ url: jira.url, projects: [...scope.projects].sort(), types: [...scope.issueTypes].sort() });
  const sameScope = getMeta(d, "jira.scope") === signature;
  const lastSync = Number(getMeta(d, "jira.lastSync") ?? 0);
  const lastFull = Number(getMeta(d, "jira.fullSyncAt") ?? 0);
  const now = Date.now();
  const full = !sameScope || lastSync === 0 || now - lastFull >= FULL_SYNC_EVERY_MS;

  let loaded = 0;
  if (scope.projects.length > 0 && scope.issueTypes.length > 0) {
    let jql = `project in (${scope.projects.map(quote).join(", ")}) AND issuetype in (${scope.issueTypes.map(quote).join(", ")})`;
    if (!full) {
      // Relative minutes keep the delta independent of the Jira user's time zone.
      const minutes = Math.ceil((now - lastSync) / 60_000) + DELTA_OVERLAP_MIN;
      jql += ` AND updated >= -${minutes}m`;
    }
    const issues = await jira.search(`${jql} ORDER BY key`, (n) => report(`Jira: ${full ? "all" : "updated"} issues loaded: ${n}`));
    loaded = issues.length;
    const upsert = d.prepare("insert or replace into jira_issue (key, project, data) values (?, ?, ?)");
    tx(d, () => {
      if (full) d.exec("delete from jira_issue");
      for (const i of issues) upsert.run(i.key, i.project, JSON.stringify(i));
    });
  } else {
    d.exec("delete from jira_issue");
  }

  tx(d, () => {
    setMeta(d, "jira.scope", signature);
    setMeta(d, "jira.lastSync", String(now));
    if (full) setMeta(d, "jira.fullSyncAt", String(now));
  });
  const issues = (d.prepare("select data from jira_issue order by project, key").all() as { data: string }[]).map((r) => JSON.parse(r.data) as JiraIssue);
  return { issues, sync: { full, loaded, total: issues.length } };
}
