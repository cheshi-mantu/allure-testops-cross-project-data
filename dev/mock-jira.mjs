// Tiny stand-in for Jira Cloud to try the coverage tab without a real site:
//   node dev/mock-jira.mjs   → http://localhost:9091, email "dev@example.com", API token "jira-token"
import { createServer } from "node:http";

const AUTH = `Basic ${Buffer.from("dev@example.com:jira-token").toString("base64")}`;
const types = ["Epic", "Feature", "Story", "Task", "Bug"];
const statuses = [
  { name: "To Do", statusCategory: { key: "new" } },
  { name: "In Progress", statusCategory: { key: "indeterminate" } },
  { name: "Done", statusCategory: { key: "done" } },
];
const projects = [
  { key: "JIRA", name: "Main product", issueTypes: types.map((name) => ({ name })) },
  { key: "OPS", name: "Operations", issueTypes: [{ name: "Task" }, { name: "Bug" }] },
];

let issues = [];
const day = 86_400_000;
for (let n = 1; n <= 130; n++) {
  issues.push({ key: `JIRA-${n}`, project: "JIRA", type: types[n % types.length], summary: `Product issue number ${n}`, status: statuses[n % 3], updated: Date.now() - n * day });
}
for (let n = 1; n <= 20; n++) {
  issues.push({ key: `OPS-${n}`, project: "OPS", type: n % 2 ? "Task" : "Bug", summary: `Operations issue ${n}`, status: statuses[n % 3], updated: Date.now() - n * day });
}
let searches = 0;

const list = (s) => [...s.matchAll(/"([^"]+)"/g)].map((m) => m[1]);

createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  const send = (status, body) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };
  console.log(req.method, url.pathname + url.search);
  // Mock controls, no auth: POST /mock/issue/{key}/update or /delete, GET /mock/stats.
  let c;
  if ((c = url.pathname.match(/^\/mock\/issue\/([A-Z]+-\d+)\/(update|delete)$/))) {
    const issue = issues.find((i) => i.key === c[1]);
    if (c[2] === "update" && issue) {
      issue.updated = Date.now();
      issue.status = statuses[2];
      issue.summary += " (updated)";
    }
    if (c[2] === "delete") issues = issues.filter((i) => i.key !== c[1]);
    return send(200, { ok: Boolean(issue) });
  }
  if (url.pathname === "/mock/stats") return send(200, { searches });
  if (req.headers.authorization !== AUTH) return send(401, { errorMessages: ["Client must be authenticated to access this resource."] });

  if (url.pathname === "/rest/api/3/myself") return send(200, { displayName: "Dev User", emailAddress: "dev@example.com" });
  if (url.pathname === "/rest/api/3/project/search") return send(200, { values: projects, isLast: true, total: projects.length });
  if (url.pathname === "/rest/api/3/search/jql" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      searches++;
      const { jql, maxResults = 50, nextPageToken } = JSON.parse(body);
      const inProjects = list(jql.match(/project in \(([^)]*)\)/)?.[1] ?? "");
      const inTypes = list(jql.match(/issuetype in \(([^)]*)\)/)?.[1] ?? "");
      const minutes = Number(jql.match(/updated >= -(\d+)m/)?.[1] ?? 0);
      const found = issues.filter(
        (i) =>
          (inProjects.length === 0 || inProjects.includes(i.project)) &&
          (inTypes.length === 0 || inTypes.includes(i.type)) &&
          (!minutes || i.updated >= Date.now() - minutes * 60_000),
      );
      const start = Number(nextPageToken ?? 0);
      const page = found.slice(start, start + maxResults);
      send(200, {
        issues: page.map((i) => ({
          id: i.key,
          key: i.key,
          fields: {
            summary: i.summary,
            issuetype: { name: i.type },
            status: i.status,
            project: { key: i.project },
            updated: new Date(i.updated).toISOString(),
          },
        })),
        ...(start + maxResults < found.length ? { nextPageToken: String(start + maxResults) } : {}),
      });
    });
    return;
  }
  send(404, { errorMessages: ["Not found"] });
}).listen(9091, () => console.log("Mock Jira on http://localhost:9091, email dev@example.com, token jira-token"));
