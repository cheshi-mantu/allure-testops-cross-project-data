# Allure TestOps analytics

A containerized React and Node.js application that reads the Allure TestOps REST API and shows:

- **Launches** of all projects as a "project → (creator) → launch" tree: all open launches, plus closed launches of the last 30 days that still have unresolved results. Each launch shows its state, result counts by status (passed, failed, broken, skipped, unknown, in progress), unresolved and muted result counts, and new / known defect counts. Launches can be filtered by state, tags, environment and part of the name, and by having not passed results (anything but passed and in progress), results in progress, unresolved results, defects or muted results; these flags combine with AND. The second grouping level, by creator, is turned on with a switch.
- **Defects** of all projects as a tree with dynamic grouping by project, status, linked issue tracker task, creator and matcher regex. Levels follow the order in which they were selected. Defects can be filtered by status, creator, issue tracker task, name or ID, and by the text of their matcher regexes. Each defect shows its matchers and the number of affected test cases, test results and launches; groups show the sum over their defects.
- **Test cases** of all projects as a tree whose structure the user defines: up to 6 grouping levels in any order, chosen from project, automation (automated or manual), layer, issue, tag, every member role (Owner, Lead and so on) and every custom field found in the data. Project is an ordinary level and can be left out. A test case with several values in a level (several issues, owners or custom field values) appears in each of their groups. Every group, and the total line, shows two counters: automated and manual test cases. Test cases can be filtered by part of the name or ID, project, tags, and by any of the grouping dimensions through **Add filter**; every filter must match, and inside one filter any selected value is enough. Groups start collapsed and top-level rows are paged, so large projects stay responsive.
- **Test case map**: the same grouping and filters as a sunburst or treemap, on its own tab. Segment size is the number of test cases; colour is either the automated share (red is manual, green is automated) or the group. Clicking a segment zooms into it. A test case with several values on a level is split evenly between their groups, so segments add up to their parent.
- **Automation trend**: automated and manual test case counts and the automated share per day, for all or selected projects, over 30 days to all time, or the automated share of several projects side by side. The history is rebuilt from the change log of every test case and kept between refreshes (see [Automation history](#automation-history)).
- **Outdated** test cases: those not run for at least 15, 30, 60 or 90 days, and those never run at all, grouped by project and filtered by name, project, automation and current status. Selected test cases (one by one, a whole project, or everything shown) can get a new workflow and status in one go; the application asks for confirmation and applies it on behalf of the API token owner, one bulk request per project.

Launches can be sorted by name, ID and creation date, defects by name, ID and linked issue; sorting orders rows inside each group, groups keep their order, and empty values stay last. Table columns can be resized by dragging the right edge of a header; long content wraps inside its column. Widths are remembered per table in the browser, and **Reset column widths** restores the defaults.

## Finding the same defect in different projects

Every defect can have matchers: a message regex and/or a trace regex that Allure TestOps uses to link test results to the defect. The **Matcher regex** row on the Defects tab works with them:

- **Message + trace / Message / Trace** selects which part of a matcher is searched and compared.
- **Regex text contains** keeps defects whose matcher regex (in the selected part) contains the text, case-insensitively.
- **Shared by several projects** keeps only regexes used by defects of two or more projects and switches grouping to "regex → project", so each group is one regex with the projects that use it. Regexes are compared ignoring case and surrounding spaces.
- The **Matcher (message + trace regex)**, **Message regex** and **Trace regex** grouping levels put a defect with several matchers into several groups.

## Running

With docker compose, pulling the published image from GitHub Container Registry and keeping the settings between `down` and `up`:

```bash
docker compose up -d
```

With docker compose, building from source:

```bash
docker compose -f compose.build.yaml up -d --build
```

There are two compose files:

| File | Image | Settings after `docker compose down` |
| --- | --- | --- |
| `docker-compose.yml` (default) | `ghcr.io/cheshi-mantu/allure-testops-cross-project-data`, pulled on every `up` | kept in the `analytics-data` volume |
| `compose.build.yaml` | built locally from source | lost |

A specific release is selected with `ANALYTICS_TAG` (for example `ANALYTICS_TAG=0.2.0`, `latest` by default). The host port is set with `ANALYTICS_PORT` in both files (8080 by default). `docker compose down -v` also deletes the saved settings.

Without compose:

```bash
docker run -d --name allure-testops-cross-project-data -p 8080:8080 ghcr.io/cheshi-mantu/allure-testops-cross-project-data:latest
```

Open http://localhost:8080. On the **Settings** tab, enter the Allure TestOps URL and an API token (Allure TestOps user profile → API tokens). The auto refresh periods are set there too.

## Settings storage

The server writes the endpoint, token and refresh periods to `/app/data/config.json` inside the container. The file survives `docker restart` and `docker compose stop/start` and is gone together with the container: after `docker rm`, `docker compose down` or an image upgrade, the settings have to be entered again. `docker-compose.yml` mounts a named volume at `/app/data`, so there the settings outlive the container. The token is never sent back to the browser; the UI only sees its last 4 characters. Everything the application collects is kept in `/app/data/data.db` (see [Data storage](#data-storage)).

## Data storage

Collected data lives in one SQLite database, `/app/data/data.db`, using Node's built-in `node:sqlite` (no extra dependencies):

- **Snapshots.** The last result of every tab (launches, defects, test cases, last runs, automation history) is stored after each refresh. After a restart the stored result is shown right away, marked with its time, while a fresh one is collected in the background.
- **Test case cache.** One row per test case; a refresh writes only new, changed and removed test cases (see [Test case cache](#test-case-cache)).
- **Automation history** and **last runs**: see [Automation history](#automation-history) and [Last runs](#last-runs).

The database belongs to one Allure TestOps instance: changing the endpoint or token clears it. With `docker-compose.yml` it sits in the `analytics-data` volume and survives `docker compose down` / `up` and image upgrades. Files of earlier versions (`history.db`, `cache/`) are migrated or removed on start.

## Automation history

The automation trend is rebuilt from test case change logs and kept in the database:

- The first refresh loads the change log of every test case, deleted ones included: one request per test case, once.
- Later refreshes list test cases (active and deleted, one request per 1000) and load the change log again only for test cases whose automation or deletion state differs from the stored one, plus new test cases.
- A test case that disappears from both lists was deleted for good; it is counted as deleted from the moment the application noticed it, since its change log is gone too.
- History has its own auto refresh period (Automation trend in Settings).

Before the first entry of its change log a test case is taken to be in its first recorded state. Test cases deleted for good before the application started tracking them are not in the history.

## Last runs

The Outdated tab needs to know when each test case last ran. It is worked out from launches and kept in the same SQLite database:

- Launches created in the last 90 days are listed per project. For each launch the IDs of test cases with a finished result are read, and each of those test cases gets the launch's creation date as its last run.
- A closed launch is read once; open launches are read again on every refresh, since results can still be added to them.
- A test case not seen in these launches is checked once for any finished result at all, in chunks of test cases; a chunk with results is split until each test case is known. It is then either "ran more than 90 days ago" or "never ran".
- The data has its own auto refresh period (Outdated in Settings).

Setting a status calls `POST /api/rs/testcase/bulk/status/set` with the selected test case IDs, the workflow and the status; the status must belong to the chosen workflow. The token owner needs write access to the project. Note that automated uploads can later set workflow and status of a test case back to their defaults, for example when a trashed test case is uploaded again.

## Test case cache

Loading the details of a test case takes one request, so the test case list is refreshed incrementally:

- Every refresh lists all test cases (one request per 1000 test cases) and compares their modification dates with the cache.
- Details are requested only for new test cases and those whose modification date changed. Test cases that disappeared are dropped.
- A project that fails to list keeps its cached test cases.
- Once a day, and with **Reload all details** on the Test cases tab, every test case is reloaded, which also picks up changes that do not move the modification date, such as a renamed custom field value.
- The cache is kept in the database, so a restarted container continues from it.

The Test cases tab shows what the last refresh did: how many details were loaded, taken from the cache or removed.

## Data refresh

- The server caches the result of crawling Allure TestOps. The browser only polls this cache.
- Auto refresh is lazy: a new crawl starts when someone has the page open and the configured period has passed. Nobody watching means no load on Allure TestOps.
- Any crawl, automatic or manual, starts at most once per 60 seconds. The limit is enforced on the server: an early `POST /api/*/refresh` gets `429` with `Retry-After`.
- Every tab has its own auto refresh period in Settings: Launches, Defects, Test cases (shared with Test case map), Automation trend and Outdated. 0 disables auto refresh for that tab; the Refresh button still works. By default only Launches refresh automatically, every 5 minutes.

## Requests sent to Allure TestOps

| Data | Request |
| --- | --- |
| Authentication | `POST /api/uaa/oauth/token` (`grant_type=apitoken`) → JWT |
| Projects | `GET /api/rs/project` |
| Open launches | `GET /api/rs/launch?projectId=…&preview=true&search=<base64 [{"id":"close","type":"boolean","value":false}]>`. One request per page returns tags, environment, creator and defect counts |
| Closed launches of the last 30 days | the same request with `[{"id":"close","type":"boolean","value":true},{"id":"createdAfter","type":"long","value":<epoch ms>}]`; it also returns result counts by status |
| Launch details | `GET /api/rs/launch/{id}/unresolved?size=1` and `GET /api/rs/launch/{id}/muted?size=1`, reading `totalElements`; `GET /api/rs/launch/{id}/statistic` for launches the list returns without result counts |
| Defects | `GET /api/rs/defect?projectId=…`. The `count` field holds the number of affected test cases |
| Defect counters | `GET /api/rs/defect/{id}/testresult?size=1` and `GET /api/rs/defect/{id}/launch?size=1`, reading `totalElements` |
| Defect matchers | `GET /api/rs/defect/{id}/matcher` |
| Test cases | `GET /api/rs/testcase/__search?projectId=…&rql=true`, reading `id`, `name`, `lastModifiedDate` and `automated` |
| Test case details | `GET /api/rs/testcase/{id}/overview`: layer, tags, issues, members, custom fields |
| Test cases for the history | `GET /api/rs/testcase/__search?projectId=…&rql=true&deleted=false` and `&deleted=true`, reading `id`, `createdDate` and `automated` |
| Change log | `GET /api/rs/testcase/audit?testCaseId=…`: automation and deletion changes with their time |
| Launches for last runs | `GET /api/rs/launch/__search?projectId=…&rql=createdDate >= <epoch ms>` |
| Test cases run in a launch | `GET /api/rs/testresult/__search?projectId=…&rql=launch = <id> and status != null`, reading `testCaseId` |
| Ever run check | `GET /api/rs/testresult/query/validate?projectId=…&rql=testCaseId in [<ids>] and status != null`, reading `count` |
| Workflows and statuses | `GET /api/rs/workflow`, `GET /api/rs/workflow/{id}` |
| Setting a status (write) | `POST /api/rs/testcase/bulk/status/set` with `{"selection":{"projectId":…,"inverted":false,"leafsInclude":[…],"search":""},"workflowId":…,"statusId":…}` |

Pages are requested 1000 items at a time. At most 8 requests to Allure TestOps run concurrently.

## Limitations

- **Defect creator.** The Allure TestOps API does not return who created a defect. Matchers do have an author, so the author of the defect's earliest matcher is taken as the defect creator and marked "(matcher)" in the UI. This is an approximation: someone else may have added the matcher later. Defects without matchers stay under "(creator unknown)". If the server starts returning `createdBy` in the defect list, that value wins.
- **Cost of launch details.** Unresolved and muted counts take a request each per launch, and open launches need one more for result counts. A closed launch without unresolved results is dropped after the first request.
- **Cost of defect details.** Matchers, test results and launches take three requests per defect. On an instance with thousands of defects a crawl takes noticeable time, so defect auto refresh is off by default.
- **Cost of test case details.** The first load requests details for every test case, one request each; later refreshes only for new and changed ones.
- **Access to the application.** The application itself has no authentication: anyone who opens the page sees the data and can change the settings. Expose it on an internal network only.
- The application sees only the projects the token owner has access to.

## Build and publishing on GitHub

The image is built only when a GitHub release is published. Regular pushes and pull requests do not build it.

- `.github/workflows/release.yml` runs on the `release: published` event. It type-checks and builds the application, then builds the image for `linux/amd64` and `linux/arm64` and publishes it to GitHub Container Registry as `ghcr.io/cheshi-mantu/allure-testops-cross-project-data`.
- `.github/workflows/ci.yml` runs on pushes to `main`/`master` and on pull requests and only type-checks and builds the application (`npm ci`, `npm run typecheck`, `npm run build`).

| Release | Image tags |
| --- | --- |
| `v1.2.3` | `1.2.3`, `1.2`, `latest` |
| `v1.3.0-rc.1`, marked as pre-release | `1.3.0-rc.1` |

The release tag must be semver (`v1.2.3` or `1.2.3`), otherwise no image tags are produced.

No secrets need to be configured: the workflow logs in to the registry with `GITHUB_TOKEN` and the `packages: write` permission. After the first publication the GHCR package is private. It can be made public in the package settings on GitHub (Package settings → Change visibility).

Releasing a version with the GitHub CLI:

```bash
gh release create v0.1.0 --generate-notes
```

Or in the web UI: Releases → Draft a new release → Publish release. Pushing a tag without a release does not build the image.

Health check: `GET /api/health`, used by `HEALTHCHECK` in the Dockerfile.

## Development

```bash
npm install
```

```bash
node dev/mock-testops.mjs
```

```bash
npm run dev
```

`dev/mock-testops.mjs` starts an Allure TestOps stub on http://localhost:9090 with the token `mock-token`. `npm run dev` starts the server on :8080 and Vite on http://localhost:5173.

Layout:

- `server/src/testops.ts`: Allure TestOps client (authentication, pagination, concurrency limit).
- `server/src/collect.ts`: walks projects, collects launches and defects.
- `server/src/dataset.ts`: cache with a refresh rate limit.
- `server/src/config.ts`: settings storage inside the container.
- `web/src/`: React UI on Ant Design. Filtering and grouping run in the browser.

## License

[Apache License 2.0](LICENSE)
