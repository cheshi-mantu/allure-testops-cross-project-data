#!/usr/bin/env node
// Initial success rate of a launch: the share of tests whose first automated
// attempt passed, before any rerun.
//
//   initial success rate = automated tests whose initial attempt passed / all tests in the launch
//
// Every test counts once. Manual tests count in the denominator only.
//
// Usage:
//   ALLURE_TOKEN=<api token> node examples/initial-success-rate.mjs \
//     --endpoint https://testops.example.com --project 1 --launch 1234
//
// Node.js 18 or newer, no dependencies.

import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const PAGE_SIZE = 1000;
const PARALLEL = 8;
const READ_ATTEMPTS = 4;
const TIMEOUT_MS = 60_000;
const STATUSES = ["passed", "failed", "broken", "skipped", "unknown"];

function usage(problem) {
  if (problem) console.error(`${problem}\n`);
  console.error(
    [
      "Usage: node examples/initial-success-rate.mjs --endpoint <url> --project <id> --launch <id> [--token <api token>]",
      "",
      "  --endpoint  Allure TestOps URL, for example https://testops.example.com (or ALLURE_ENDPOINT)",
      "  --token     API token of a user who can read the project (or ALLURE_TOKEN)",
      "  --project   project ID",
      "  --launch    launch ID",
    ].join("\n"),
  );
  process.exit(2);
}

function options() {
  let values;
  try {
    ({ values } = parseArgs({
      options: {
        endpoint: { type: "string" },
        token: { type: "string" },
        project: { type: "string" },
        launch: { type: "string" },
        help: { type: "boolean", short: "h" },
      },
    }));
  } catch (e) {
    usage(e.message);
  }
  if (values.help) usage();
  const endpoint = (values.endpoint ?? process.env.ALLURE_ENDPOINT ?? "").replace(/\/+$/, "");
  const token = values.token ?? process.env.ALLURE_TOKEN ?? "";
  const projectId = Number(values.project);
  const launchId = Number(values.launch);
  if (!/^https?:\/\//.test(endpoint)) usage("The Allure TestOps URL is missing or does not start with http:// or https://.");
  if (!token) usage("The API token is missing: pass --token or set ALLURE_TOKEN.");
  if (!Number.isSafeInteger(projectId) || projectId <= 0) usage("The project ID must be a positive number.");
  if (!Number.isSafeInteger(launchId) || launchId <= 0) usage("The launch ID must be a positive number.");
  return { endpoint, token, projectId, launchId };
}

/** A small Allure TestOps client: one token exchange per run, repeated reads, Spring paging. */
class Client {
  constructor(endpoint, token) {
    this.endpoint = endpoint;
    this.token = token;
    this.auth = null;
    this.requests = 0;
  }

  /** Exchanges the API token for a bearer token once; falls back to the API token itself. */
  async authorization() {
    if (this.auth) return this.auth;
    try {
      const res = await fetch(`${this.endpoint}/api/uaa/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body: new URLSearchParams({ grant_type: "apitoken", scope: "openid", token: this.token }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const body = res.ok ? await res.json().catch(() => null) : null;
      this.auth = body?.access_token ? `Bearer ${body.access_token}` : `Api-Token ${this.token}`;
    } catch {
      this.auth = `Api-Token ${this.token}`;
    }
    return this.auth;
  }

  /** GET with JSON; repeats server errors and HTML pages answered instead of JSON. */
  async get(path, params = {}) {
    const url = new URL(this.endpoint + path);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
    let last;
    for (let attempt = 1; attempt <= READ_ATTEMPTS; attempt++) {
      this.requests++;
      try {
        const res = await fetch(url, { headers: { Authorization: await this.authorization(), Accept: "application/json" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
        const type = res.headers.get("content-type") ?? "";
        if (res.status === 401) throw Object.assign(new Error("401 Unauthorized: the API token is wrong, expired or revoked."), { final: true });
        if (res.status === 403) throw Object.assign(new Error(`403 Forbidden for ${url.pathname}: the token owner cannot read this project.`), { final: true });
        if (res.status === 404) throw Object.assign(new Error(`404 Not Found for ${url.pathname}: check the project and launch IDs.`), { final: true });
        if (res.status >= 400 && res.status < 500) throw Object.assign(new Error(`${res.status} for ${url.pathname}: ${await res.text()}`), { final: true });
        if (res.ok && type.includes("application/json")) return await res.json();
        last = new Error(res.ok ? `Allure TestOps answered ${url.pathname} with a web page instead of JSON` : `${res.status} for ${url.pathname}`);
      } catch (e) {
        if (e.final) throw e;
        last = e;
      }
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
    }
    throw last;
  }

  /** All items of a paged answer; also takes a plain array. */
  async all(path, params = {}) {
    const items = [];
    for (let page = 0; ; page++) {
      const p = await this.get(path, { ...params, page, size: PAGE_SIZE });
      if (Array.isArray(p)) return p;
      items.push(...p.content);
      if (p.last || p.content.length === 0 || page + 1 >= p.totalPages) return items;
    }
  }
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i]);
      }
    }),
  );
  return results;
}

const status = (s) => (s ? String(s).toLowerCase() : null);

/** The oldest earlier attempt of a visible result; the API lists retries from the newest. */
function oldest(retries) {
  return retries.reduce((a, b) => {
    const ka = a.start ?? a.createdDate ?? a.id;
    const kb = b.start ?? b.createdDate ?? b.id;
    return kb < ka || (kb === ka && b.id < a.id) ? b : a;
  });
}

export async function initialSuccessRate(client, projectId, launchId) {
  const search = (rql) => client.all("/api/rs/testresult/__search", { projectId, rql, sort: "id,asc" });

  const launch = await client.get(`/api/rs/launch/${launchId}`);
  const progress = await client.get(`/api/rs/launch/${launchId}/progress`).catch(() => null);

  // 1. Every test of the launch, counted once: its visible result is the latest attempt.
  const visible = await search(`launch = ${launchId} and hidden = false`);
  // 2. Automated tests.
  const automated = await search(`launch = ${launchId} and hidden = false and manual = false`);
  // 3. Tests that were rerun: earlier attempts are hidden.
  const hidden = await search(`launch = ${launchId} and hidden = true`);
  const rerunCases = new Set(hidden.map((r) => r.testCaseId).filter((id) => id !== null && id !== undefined));

  // 4. The initial attempt: the oldest earlier attempt of a rerun test, the visible result otherwise.
  let retryCalls = 0;
  const initial = await mapLimit(automated, PARALLEL, async (r) => {
    const withoutCase = r.testCaseId === null || r.testCaseId === undefined;
    // A result without a test case cannot be matched with hidden results: its retries are always read.
    if (!withoutCase && !rerunCases.has(r.testCaseId)) return { result: r, status: status(r.status), rerun: false, withoutCase };
    retryCalls++;
    const retries = await client.all(`/api/rs/testresult/${r.id}/retries`, { sort: "start,desc" });
    if (retries.length === 0) return { result: r, status: status(r.status), rerun: false, withoutCase };
    return { result: r, status: status(oldest(retries).status), rerun: true, withoutCase };
  });

  // 5. Initial statuses of automated tests.
  const initialCounts = Object.fromEntries(STATUSES.map((s) => [s, 0]));
  let noStatus = 0;
  for (const i of initial) {
    if (i.status && i.status in initialCounts) initialCounts[i.status]++;
    else noStatus++;
  }
  const currentPassed = visible.filter((r) => status(r.status) === "passed").length;

  // 6. The rates; no tests, no rate.
  const total = visible.length;
  return {
    launch: { id: launch.id, name: launch.name },
    ready: progress ? Boolean(progress.ready) : null,
    total,
    automated: automated.length,
    manual: total - automated.length,
    rerun: initial.filter((i) => i.rerun).length,
    withoutTestCase: initial.filter((i) => i.withoutCase).length,
    initial: initialCounts,
    noStatus,
    initialSuccessRate: total ? (initialCounts.passed / total) * 100 : null,
    currentSuccessRate: total ? (currentPassed / total) * 100 : null,
    currentPassed,
    retryCalls,
    requests: client.requests,
  };
}

function print(r) {
  const pct = (v) => (v === null ? "n/a (the launch has no tests)" : `${v.toFixed(2)} %`);
  const lines = [
    `Launch                            ${r.launch.id} ${r.launch.name}`,
    `Tests in the launch               ${r.total}`,
    `  automated                       ${r.automated}`,
    `  manual                          ${r.manual}`,
    `Automated tests rerun             ${r.rerun}`,
    `Initial status of automated tests`,
    ...STATUSES.map((s) => `  ${s.padEnd(32)}${r.initial[s]}`),
    ...(r.noStatus ? [`  no status yet                   ${r.noStatus}`] : []),
    `Initial success rate              ${pct(r.initialSuccessRate)}  (${r.initial.passed} of ${r.total})`,
    `Current success rate              ${pct(r.currentSuccessRate)}  (${r.currentPassed} of ${r.total}, visible results)`,
  ];
  if (r.withoutTestCase) lines.push(`Note: ${r.withoutTestCase === 1 ? "1 automated result has no test case; its" : `${r.withoutTestCase} automated results have no test case; their`} earlier attempts were read directly.`);
  if (r.ready === false) lines.push("Warning: the launch is still processing uploads; the numbers may change.");
  console.log(lines.join("\n"));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const o = options();
  try {
    print(await initialSuccessRate(new Client(o.endpoint, o.token), o.projectId, o.launchId));
  } catch (e) {
    console.error(`Failed: ${e.message}`);
    process.exit(1);
  }
}

export { Client };
