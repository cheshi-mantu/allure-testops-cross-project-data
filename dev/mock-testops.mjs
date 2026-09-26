// Tiny stand-in for Allure TestOps to try the app without a real instance:
//   node dev/mock-testops.mjs   → http://localhost:9090, API token "mock-token"
import { createServer } from "node:http";

const TOKEN = "mock-token";
const JWT = "mock-jwt";
const users = ["alice", "bob", "carol"];
const envs = [["browser", "chrome"], ["browser", "firefox"], ["stand", "stage"], ["stand", "prod"]];
const tagNames = ["smoke", "regress", "nightly", "api"];

const matcherTemplates = [
  [{ messageRegex: "Timeout.*waiting for element", traceRegex: null }],
  [{ messageRegex: "NullPointerException", traceRegex: "at com\\.shop\\.Cart" }],
  [],
  [
    { messageRegex: "Connection refused", traceRegex: null },
    { messageRegex: null, traceRegex: "SocketTimeoutException" },
  ],
];

const projects = [
  { id: 1, name: "Web Shop" },
  { id: 2, name: "Mobile App" },
  { id: 7, name: "Backend API" },
];

let seq = 100;
const launches = [];
const defects = [];
for (const p of projects) {
  for (let i = 0; i < 12; i++) {
    const id = seq++;
    launches.push({
      id,
      name: `${p.name} ${tagNames[i % 4]} #${i}`,
      projectId: p.id,
      closed: i % 3 === 0,
      tags: [{ id: i % 4, name: tagNames[i % 4] }, ...(i % 5 === 0 ? [{ id: 9, name: "release" }] : [])],
      environment: [envs[i % 2], envs[2 + (i % 2)]].map(([n, v], k) => ({ id: k, name: v, variable: { id: k, name: n } })),
      createdBy: users[i % 3],
      // Every third launch is closed; some of them are older than 30 days.
      createdDate: Date.now() - (i % 3 === 0 ? i * 4 : i) * 86_400_000,
      // Status null means the result is still in progress.
      statistic: [
        { status: "passed", count: 20 + i },
        ...(i % 2 ? [{ status: "failed", count: i }] : []),
        ...(i % 4 === 1 ? [{ status: "broken", count: 2 }] : []),
        ...(i % 3 === 1 ? [{ status: null, count: 3 }] : []),
      ],
      unresolved: i % 2 ? i : 0,
      muted: i % 5 === 2 ? 1 : 0,
      newDefectsCount: i % 4 === 3 ? 1 : 0,
      knownDefectsCount: i % 2,
    });
  }
  for (let i = 0; i < 6; i++) {
    const id = seq++;
    defects.push({
      id,
      projectId: p.id,
      name: `${p.name}: defect ${i}`,
      closed: i % 3 === 2,
      issue: i % 2 === 0 ? { id, name: `JIRA-${10 + i}`, url: `https://jira.example.com/browse/JIRA-${10 + i}` } : null,
      count: i + 1,
      matchers: matcherTemplates[(i + p.id) % matcherTemplates.length].map((m, k) => ({
        id: id * 10 + k,
        defectId: id,
        name: `matcher ${k}`,
        createdBy: users[(i + k) % users.length],
        createdDate: Date.now() - (10 - k) * 86_400_000,
        ...m,
      })),
    });
  }
}

const layers = ["UI", "API", "Unit", null];
const features = ["Cart", "Checkout", "Login", "Search"];
let testCases = [];
for (const p of projects) {
  for (let i = 0; i < 40; i++) {
    const id = 1000 + p.id * 100 + i;
    const layer = layers[i % 4];
    testCases.push({
      id,
      projectId: p.id,
      name: `${p.name}: ${features[i % 4]} scenario ${i}`,
      lastModifiedDate: Date.now() - i * 60_000,
      automated: i % 3 !== 0,
      layer: layer && { id: i % 4, name: layer },
      tags: [{ id: i % 4, name: tagNames[i % 4] }],
      issues: i % 3 === 0 ? [{ id, name: `JIRA-${100 + (i % 7)}`, url: `https://jira.example.com/browse/JIRA-${100 + (i % 7)}` }] : null,
      members: [
        { id: 1, name: users[i % 3], role: { id: 1, name: "Owner" } },
        ...(i % 4 === 0 ? [{ id: 2, name: users[(i + 1) % 3], role: { id: 2, name: "Lead" } }] : []),
      ],
      customFields: [
        { id: i % 4, name: features[i % 4], customField: { id: 1, name: "Feature" } },
        ...(i % 5 === 0 ? [] : [{ id: 10 + (i % 2), name: i % 2 ? "High" : "Low", customField: { id: 2, name: "Priority" } }]),
        ...(i % 6 === 0
          ? [
              { id: 20, name: "web", customField: { id: 3, name: "Platform" } },
              { id: 21, name: "mobile", customField: { id: 3, name: "Platform" } },
            ]
          : []),
      ],
    });
  }
}
let overviewRequests = 0;

const page = (items, url) => {
  const n = Number(url.searchParams.get("page") ?? 0);
  const size = Number(url.searchParams.get("size") ?? 10);
  const content = items.slice(n * size, n * size + size);
  const totalPages = Math.ceil(items.length / size);
  return { content, totalElements: items.length, totalPages, number: n, size, last: n + 1 >= totalPages };
};

createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  const send = (status, body) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };
  console.log(req.method, url.pathname + url.search);
  if (req.method === "POST" && url.pathname === "/api/uaa/oauth/token") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const params = new URLSearchParams(body);
      if (params.get("token") !== TOKEN) return send(401, { error: "invalid_token" });
      send(200, { access_token: JWT, token_type: "bearer", expires_in: 3600 });
    });
    return;
  }
  // Mock controls, no auth: POST /mock/testcase/{id}/touch or /delete, GET /mock/stats.
  let c;
  if ((c = url.pathname.match(/^\/mock\/testcase\/(\d+)\/(touch|delete)$/))) {
    const t = testCases.find((x) => x.id === Number(c[1]));
    if (c[2] === "touch" && t) {
      t.lastModifiedDate = Date.now();
      t.tags = [...t.tags, { id: 99, name: "touched" }];
    }
    if (c[2] === "delete") testCases = testCases.filter((x) => x.id !== Number(c[1]));
    return send(200, { ok: Boolean(t) });
  }
  if (url.pathname === "/mock/stats") return send(200, { overviewRequests });
  if (req.headers.authorization !== `Bearer ${JWT}`) return send(401, { message: "Unauthorized" });
  const path = url.pathname.replace(/^\/api\/rs\//, "/api/");
  const projectId = Number(url.searchParams.get("projectId"));
  let m;
  if (path === "/api/project") return send(200, page(projects, url));
  if (path === "/api/launch") {
    const search = JSON.parse(Buffer.from(url.searchParams.get("search") ?? "W10=", "base64").toString());
    const closed = search.find((c) => c.id === "close")?.value;
    const after = search.find((c) => c.id === "createdAfter")?.value ?? 0;
    const found = launches
      .filter((l) => l.projectId === projectId && (closed === undefined || l.closed === closed) && l.createdDate >= after)
      // The list carries result counts for closed launches only.
      .map(({ unresolved, muted, statistic, ...l }) => ({ ...l, statistic: l.closed ? statistic : null }));
    return send(200, page(found, url));
  }
  if ((m = path.match(/^\/api\/launch\/(\d+)\/(statistic|unresolved|muted)$/))) {
    const l = launches.find((x) => x.id === Number(m[1]));
    if (m[2] === "statistic") return send(200, l.statistic);
    return send(200, { content: [], totalElements: l[m[2]], totalPages: l[m[2]], last: false });
  }
  if (path === "/api/testcase/__search") {
    const rows = testCases.filter((t) => t.projectId === projectId).map(({ id, name, lastModifiedDate, automated }) => ({ id, name, lastModifiedDate, automated }));
    return send(200, page(rows, url));
  }
  if ((m = path.match(/^\/api\/testcase\/(\d+)\/overview$/))) {
    overviewRequests++;
    const t = testCases.find((x) => x.id === Number(m[1]));
    return t ? send(200, t) : send(404, { message: "Not found" });
  }
  if (path === "/api/defect") {
    return send(200, page(defects.filter((d) => d.projectId === projectId).map(({ projectId, matchers, ...d }) => d), url));
  }
  if ((m = path.match(/^\/api\/defect\/(\d+)\/matcher$/))) {
    return send(200, page(defects.find((x) => x.id === Number(m[1])).matchers, url));
  }
  if ((m = path.match(/^\/api\/defect\/(\d+)\/(testresult|launch|testcase)$/))) {
    const d = defects.find((x) => x.id === Number(m[1]));
    const total = { testresult: d.count * 4, launch: d.count + 1, testcase: d.count }[m[2]];
    return send(200, { content: [], totalElements: total, totalPages: total, last: false });
  }
  send(404, { message: "Not found" });
}).listen(9090, () => console.log("Mock Allure TestOps on http://localhost:9090, token: mock-token"));
