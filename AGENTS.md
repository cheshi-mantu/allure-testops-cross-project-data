# AGENTS.md

Guide for coding agents (and people) who build a new tool that migrates test cases into Allure TestOps from another test management system (TMS): TestRail, Zephyr, Xray, qTest, TestLink, Azure Test Plans, a spreadsheet export and so on. It covers the ground rules, the technology, the parts of this repository worth reusing, the shape of a migration, and the Allure TestOps REST API as a migration uses it.

This repository itself is an analytics tool (launches, defects, test cases, automation trend, Jira coverage). It reads Allure TestOps through the same public REST API, so its client, storage and delivery setup are a good starting point. A complete migration tool with a TestRail and a CSV source lives in the public repository [qameta/allure-testops-migration](https://github.com/qameta/allure-testops-migration); read its `AGENTS.md` before starting a new variant.

## Ground rules

- **Public API only.** Allure TestOps is a closed source commercial product. Rely only on the behaviour of its public REST API (the API documentation served by the instance and the public client libraries). In code, comments, docs and UI mention only public API paths and fields. No guesses or statements about its database, internal services, server classes or internal logic. Do not use endpoints hidden from the API documentation (for example `api/ext/...`), even if the web application calls them.
- **Check every endpoint against the current server.** Older tools and client libraries use endpoints that were removed (for example `api/rs/field` answers 404). Before relying on a path, call it on a real or demo instance.
- **Secrets stay on the server.** API tokens, passwords and keys are stored only by the backend of the tool (a config file in the data volume). The browser gets a mask or the last 4 characters. Exports of settings leave secrets out unless the user opts in.
- **Safe to run again.** A rerun updates what an earlier run created and never duplicates it. See "Reruns and idempotency".
- **Explain every problem.** Each error a user can meet says what happened, why, and where to fix it (the mapping or setting that produced the value). Raw server answers go into a detail field for support, never instead of an explanation.
- **Texts.** Everything in the repository (code, comments, README, UI) is in English. Plain short sentences, no em dashes. Refer to records the way people find them: the source id (for example `C123`) for TMS cases, "Line 12" for file rows, the Allure TestOps id for written cases.

## Technology

Use the stack of this repository unless there is a reason not to; it is small, has no native modules and builds into one container image.

| Part | Choice | Notes |
|---|---|---|
| Runtime | Node.js 22, TypeScript, ES modules | One language for server, UI and shared types. Type check with `tsc --noEmit`; run the server in development with `tsx watch`. |
| Server | Express 5 | REST API for the UI plus the built UI as static files. Fastify 5 works as well (the migration repository uses it). |
| HTTP | built-in `fetch` with `AbortSignal.timeout` | Wrap it in one client per system: auth, paging, a concurrency limit, retries with backoff and `Retry-After`. Attachments go as `FormData` (multipart). |
| Storage | built-in `node:sqlite` (`DatabaseSync`, WAL mode) in `DATA_DIR` | Run state, the source id to Allure TestOps id map, logs. Start Node with `--disable-warning=ExperimentalWarning`. Plain JSON files are enough for settings. |
| Validation | zod | One schema for the migration profile, its defaults, import and export. |
| Rich text | turndown (HTML to Markdown) | Allure TestOps descriptions, preconditions, expected results and comments are Markdown; step bodies are plain text. |
| UI | React 19, Vite, antd 6 | A wizard, mapping tables and logs need little code with antd. Use `App.useApp()` for messages and modals. Mantine is an alternative (the migration repository uses it). |
| Tests | Vitest plus fake servers | Fake Allure TestOps and fake source TMS with failure injection; end-to-end tests without real servers. |
| Delivery | Docker image on `node:22-alpine`, data in a named volume | Multi-stage build, the build stage on `$BUILDPLATFORM`, a `HEALTHCHECK` on `/api/health`. `docker-compose.yml` pulls the published image, a separate compose file builds locally. |
| CI | GitHub Actions | Type check and build on push and pull requests; build and push a multi-arch image to GHCR only when a GitHub release is published (semver tags, `latest` only for non-pre-releases). |

## Parts of this repository worth reusing

| File | What it gives a migration tool |
|---|---|
| `server/src/testops.ts` | Allure TestOps client: token auth with a fallback, a semaphore of 8 parallel requests, request timeout, Spring paging (`all`), cheap totals (`count`), readable errors. It has `get` and `post` only: add `patch`, `delete` and multipart upload, plus retries for writes as described in "Errors and load". |
| `server/src/db.ts` | One SQLite database per Allure TestOps instance, tables registered by modules (`defineTables`), `tx` with rollback, key-value meta. Switching the instance clears it. |
| `server/src/pool.ts` | `mapLimit` for bounded parallel work. |
| `server/src/config.ts` | Settings in `DATA_DIR/config.json`, secrets never returned to the browser (`toPublic`). |
| `server/src/jira.ts` | An example of a second system's client (Basic auth, token based paging, delta loads). A TMS source client looks alike. |
| `dev/mock-testops.mjs` | A fake Allure TestOps for the read endpoints of this tool (port 9090, token `mock-token`). A migration needs a fake that also accepts writes and can inject failures. |
| `Dockerfile`, `docker-compose.yml`, `compose.build.yaml`, `.github/workflows/` | Container and release setup, ready to copy. |

## How a migration works

1. **Profile.** Everything the user configures is one validated object: source type and connection, source scope (projects, suites, folders, filters), target instance and project, structure mapping, field and value mappings, options (tag prefix, concurrency, what to do with unmapped data). Saved in the data volume, exportable and importable as JSON.
2. **Discovery.** Read the source (fields with filled counts, example and distinct values, folder structure, sample cases) and the target project (custom fields, layers, statuses, roles, users, integrations, trees). Mapping screens show both sides with real values, so users map what exists instead of typing ids. Suggest mappings, never apply them silently.
3. **Transform.** A pure function turns one source record into a source-neutral planned case plus notes about anything lossy. The same function backs the preview of one case, the dry run and the migration, so the preview is exactly what gets written.
4. **Dry run.** Convert every case without writing; list fields and values that will be created, missing statuses, users and roles, values a locked custom field will refuse.
5. **Migration.** Prepare custom fields and the tree once, then write cases with modest parallelism. Retry cases that failed on the server side once at the end, one at a time. A last pass rewrites cases whose text links to cases migrated later.
6. **Run record.** Store counters, problems, the source, project and tag prefix used, and a log of source id to Allure TestOps id.

A planned case, the contract between a source and the writer, carries: `sourceId`, `sourceUrl`, optional existing Allure TestOps id, `name`, `description`, `precondition`, `expectedResult` (Markdown), `tags`, `customFields` (field name to values), `layer`, `status`, `owner`, `members` (`{ name, role }`), `links` (`{ name, url }`), `issues` (`{ key, integrationId }`), `comments`, `attachments`, `scenario` (steps with nested steps, expected results and attachments, or a shared step reference), `notes`.

### Mapping typical TMS concepts

| In the source TMS | In Allure TestOps |
|---|---|
| Folder, section, suite hierarchy | One custom field per level (for example Epic, Feature, Story) plus a tree over those fields. Let the user decide what happens to levels deeper than the mapped ones: join into the last field or drop. |
| Priority, type, component, any dropdown or text field | Custom field, with a value mapping (source value to target value or skip). |
| Case status, review state | Status of the project's workflow, mapped by name. Statuses are not created by the tool. |
| Automation type or level | Test layer (layers can be created) or a custom field. |
| Steps with expected results, step data | Scenario: nested `body` steps, `expectedResultSteps`, attachments inside steps. |
| Shared or reusable steps, called test cases | Shared steps, referenced from the scenario. |
| References to requirements, Jira keys | Issues (needs an enabled issue tracker integration in the project) or links. |
| Owner, author, assignee | Owner and members with roles; users must exist in Allure TestOps. |
| Labels | Tags. |
| Attachments, inline images | Test case attachments; inline images in Markdown point at the uploaded attachment. |
| Comments, history | Comments (history cannot be written; summarise it into a comment if the user wants it). |

## Allure TestOps REST API for migrations

All paths are relative to the instance URL, for example `https://testops.example.com/`. JSON in and out unless noted.

### Access and conventions

- **Auth.** Header `Authorization: Api-Token <token>` on every request. Alternatively exchange the token for a JWT with `POST api/uaa/oauth/token` (form fields `grant_type=apitoken`, `scope=openid`, `token=<token>`) and send `Authorization: Bearer <jwt>` until it expires; fall back to `Api-Token` if the exchange fails. Check a token with `GET api/uaa/account/me`.
- **Rights.** The token's user needs rights to edit test cases in the target project. Creating custom fields and trees may need project or instance administrator rights. Listing users usually needs administrator rights; without them let users type user names.
- **Paging.** Spring style: query `page` (0-based), `size` (up to 1000), optional `sort` (`id,asc`); answer `{ content, number, size, totalPages, totalElements, last }`. Some endpoints return a plain array: accept both. A total costs one request with `size=1`.
- **Search.** `rql` takes an Allure query language expression, for example `tag = "testrail:C123"` or `true` for everything. Escape quotes and backslashes inside values.
- **Attachments** are `multipart/form-data` with the file in the field `file`.
- **Links for people.** A test case: `<instance>/project/{projectId}/test-cases/{testCaseId}`.

### Reading the target project (discovery)

| What | Request |
|---|---|
| Projects | `GET api/rs/project`, `GET api/rs/project/{id}` |
| Custom fields bound to the project | `GET api/rs/project/{projectId}/cf` (paged; items carry `customField { id, name }`) |
| All custom fields | `GET api/rs/cf/suggest?query=&page=0&size=500` |
| Values of a custom field | `GET api/rs/cfv/suggest?customFieldId=&projectId=&query=&size=` (look values up by query; global fields can have many thousands) |
| Test layers | `GET api/rs/testlayer` |
| Workflows and their statuses | `GET api/rs/workflow` (statuses usually come with the list), `GET api/rs/workflow/{id}`; all statuses: `GET api/rs/status` |
| Member roles | `GET api/rs/role` |
| Users | `GET api/uaa/account` (`username`, `email`, `firstName`, `lastName`) |
| Issue tracker integrations | `GET api/rs/integration/project/{projectId}` (skip disabled ones) |
| Trees | `GET api/rs/tree?projectId=` |
| Existing test cases | `GET api/rs/testcase/__search?projectId=&rql=true` (`id`, `name`, `automated`, `createdDate`, `lastModifiedDate`, `status`, `workflow`); one case with layer, tags, issues, members and custom fields: `GET api/rs/testcase/{id}/overview` |

### Writing one test case

The order matters: make the case findable (the migration tag) before anything else can fail.

1. **Find.** If the source maps to an existing Allure TestOps id, `GET api/rs/testcase/{id}` and check `projectId`. Otherwise search by the migration tag: `GET api/rs/testcase/__search?projectId=&rql=tag = "<prefix>:<sourceId>"&page=0&size=2`.
2. **Create** when not found: `POST api/rs/testcase` with `{ "projectId": 1, "name": "Login works" }`. Keep the returned id for the rest of the run.
3. **Tags.** `POST api/rs/testcase/{id}/tag` with `[{ "name": "<prefix>:<sourceId>" }, { "name": "smoke" }]`. This replaces the list, so always include the migration tag.
4. **Fields.** `PATCH api/rs/testcase/{id}` with any of `name`, `description`, `precondition`, `expectedResult`, `statusId`, `workflowId`, `testLayerId`, `links: [{ "name": "...", "url": "https://..." }]`.
5. **Custom fields.** `POST api/rs/testcase/{id}/cfv` with `[{ "name": "Checkout", "customField": { "id": 12 } }]`. This replaces all values of the case: read `GET api/rs/testcase/{id}/cfv` first and send back the values of fields the migration does not manage.
6. **Issues.** `POST api/rs/testcase/{id}/issue` with `[{ "name": "ABC-123", "integrationId": 1 }]`, only with an enabled integration of the project.
7. **Owner and members.** `POST api/rs/testcase/{id}/members` with `[{ "name": "jane", "role": { "id": -1 } }, { "name": "sam", "role": { "id": 2 } }]`. Role id `-1` is the owner. This replaces the list. One unknown user fails the whole request: on failure add members one by one to keep the valid ones and report the rest.
8. **Comments.** `GET api/rs/comment?testCaseId=`, then `POST api/rs/comment` with `{ "testCaseId": 1, "body": "..." }` only for bodies not present yet.
9. **Attachments.** `GET api/rs/testcase/attachment?testCaseId=`, then `POST api/rs/testcase/attachment?testCaseId=` (multipart, field `file`) only for file names not present yet. The answer is an array with the uploaded attachment and its id.
10. **Scenario.** Remove the old steps (`GET api/rs/testcase/{id}/step`, then `DELETE api/rs/testcase/step/{stepId}` for each id in `root.children`), then `POST api/rs/testcase/{id}/scenario?v2=true` with `{ "steps": [...] }`.

Scenario step objects:

```json
{ "steps": [
  { "type": "body", "body": "Open the login page",
    "steps": [ { "type": "body", "body": "Nested step" }, { "type": "attachment", "attachmentId": 42 } ],
    "expectedResultSteps": [ { "type": "expected_body", "body": "The form is shown" } ] },
  { "type": "shared", "sharedStepId": 7 }
] }
```

Upload attachments before writing text and steps that refer to them. An inline image in Markdown: `![name](/api/rs/testcase/attachment/{attachmentId}/content)`.

### Shared steps

- Find: `GET api/rs/sharedstep?projectId=&search=<name>&archived=false` and compare names exactly. Create: `POST api/rs/sharedstep` with `{ "projectId": 1, "name": "..." }`.
- Steps: `GET api/rs/sharedstep/{id}/step`, `DELETE api/rs/sharedstep/step/{stepId}`, `POST api/rs/sharedstep/{id}/scenario` with `{ "steps": [...] }`. Attachments: `api/rs/sharedstep/attachment?sharedStepId=`.
- Give migrated shared steps a stable name that includes the source id (for example `<title> [<sourceId>]`) so reruns reuse them. Migrate each shared step once per run and cache the result.

### Custom fields, layers, statuses, roles, trees

- Custom fields are instance-wide; a project uses the ones bound to it. To use a field: find it in the project, else find it globally (`api/rs/cf/suggest`), else create it (`POST api/rs/cf` with `{ "name": "Feature" }`), then bind it with `POST api/rs/cfproject/add-to-project?projectId=` and `{ "ids": [12] }`. Cache lookups and share in-flight requests so parallel cases do not create the same field twice.
- New values are created by writing them to a case. A field can be limited to a fixed list of values or to one value per case; writing anything else gives 400. Offer a value mapping.
- Layers can be created: `POST api/rs/testlayer` with `{ "name": "API" }` (compare names case-insensitively).
- Statuses belong to workflows and roles are configured on the instance: do not create them, map source values to existing names and report missing ones in the dry run.
- A tree that groups cases by custom fields: `POST api/rs/tree` with `{ "name": "...", "projectId": 1, "fields": [{ "id": 12 }, { "id": 13 }] }`. Keep an existing tree with the same name as is.
- To change workflow and status of many cases after the migration: `POST api/rs/testcase/bulk/status/set` with `{ "selection": { "projectId": 1, "inverted": false, "leafsInclude": [101, 102], "search": "" }, "workflowId": 3, "statusId": 7 }`.

### Reruns and idempotency

- Mark every migrated case with the tag `<prefix>:<sourceId>`. The prefix is required and differs per source, so two files numbered 1, 2, 3 do not collide in one project. The prefix `testrail` matches earlier TestRail migration tools, so their cases are updated, not duplicated.
- Find before create. After a failed step reuse the id created earlier in the run instead of searching by tag (the tag may not be set yet). Store the source id to Allure TestOps id map in SQLite so an interrupted run can continue.
- Replace lists that the API replaces (tags, members, scenario); merge what belongs to the user (values of unmanaged custom fields); add only missing comments and attachments.
- Text that links to other source cases can be resolved only after those cases exist: collect such cases and rewrite them in a last pass.

### Errors and load

- **400:** the data was refused (locked custom field values, unknown users, invalid issue keys). Explain per operation and point to the mapping that produced the value.
- **401:** wrong, expired or revoked token. **403:** the user lacks a permission for this operation in this project. **404** on a case: it was deleted meanwhile.
- **429, 502, 503, 504:** repeat with backoff, honour `Retry-After`.
- **500** `An unexpected error occurred` happens under load on any operation, including creating cases. Reads can be repeated. Writes must not be repeated blindly because the server may have applied them: find the object again (by id or tag), then update.
- **200 with HTML.** Sometimes an API request is answered with status 200 and the HTML of the web application (`Content-Type: text/html`) instead of JSON. The request did not reach the API, usually under load or during a restart. It is safe to repeat. Check the content type before parsing and do not report it as a data problem.
- Keep parallelism modest: about 2 cases at a time by default (each case is several sequential requests), and no more than about 8 requests in flight per instance.

### Checking the result

- Count migrated cases with a total query (`size=1`, read `totalElements`) and compare with the run log; open a sample of cases by their links.
- `GET api/rs/testcase/{id}/overview` returns layer, tags, issues, members and custom fields of one case in one request, handy for a post-migration check of a sample.

## UX users expect

- A wizard with a done mark per step: connections (with a check button), source scope, target project, structure, field mapping, options, preview, run.
- Mappings built from live data of both systems with examples, filled counts and value tables; targets that do not exist yet are marked as "will be created", fields that exist but are not bound to the project as "will be added".
- A preview of any single case exactly as it will be written; a dry run before writing; a migration that can be cancelled and repeated; a line that says what is happening now.
- A problems list grouped by cause, with counts, affected records and a link to the setting that fixes it; a downloadable plain text log.
- Required settings block the next step and the run with a visible message instead of silent defaults.

## Testing

- Unit tests for every transform on samples shaped like real exports of the source TMS.
- A fake Allure TestOps that keeps written cases, custom fields, tags, members, attachments and scenarios in memory, with options for latency, values refused with 400, and requests answered with 500 or with an HTML page a given number of times.
- A fake source TMS with a synthetic project.
- An end-to-end test per source: migrate the synthetic project, check written cases field by field, run again and expect only updates, run once with injected failures and expect no duplicates.
