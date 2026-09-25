# Allure TestOps analytics

A containerized React and Node.js application that reads the Allure TestOps REST API and shows:

- **Open launches** of all projects as a "project → (creator) → launch" tree. Launches can be filtered by tags, environment and part of the name. The second grouping level, by creator, is turned on with a switch.
- **Defects** of all projects as a tree with dynamic grouping by project, status, linked issue tracker task, creator and matcher regex. Levels follow the order in which they were selected. Defects can be filtered by status, creator, issue tracker task, name or ID, and by the text of their matcher regexes. Each defect shows its matchers and the number of affected test cases, test results and launches; groups show the sum over their defects.

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

The server writes the endpoint, token and refresh periods to `/app/data/config.json` inside the container. The file survives `docker restart` and `docker compose stop/start` and is gone together with the container: after `docker rm`, `docker compose down` or an image upgrade, the settings have to be entered again. `docker-compose.yml` mounts a named volume at `/app/data`, so there the settings outlive the container. The token is never sent back to the browser; the UI only sees its last 4 characters. Collected data is kept in the process memory.

## Data refresh

- The server caches the result of crawling Allure TestOps. The browser only polls this cache.
- Auto refresh is lazy: a new crawl starts when someone has the page open and the configured period has passed. Nobody watching means no load on Allure TestOps.
- Any crawl, automatic or manual, starts at most once per 60 seconds. The limit is enforced on the server: an early `POST /api/*/refresh` gets `429` with `Retry-After`.
- Launches and defects are refreshed independently, each with its own period. 0 disables auto refresh.

## Requests sent to Allure TestOps

| Data | Request |
| --- | --- |
| Authentication | `POST /api/uaa/oauth/token` (`grant_type=apitoken`) → JWT |
| Projects | `GET /api/rs/project` |
| Open launches | `GET /api/rs/launch?projectId=…&preview=true&search=<base64 [{"id":"close","type":"boolean","value":false}]>`. One request per page returns tags, environment and creator at once |
| Defects | `GET /api/rs/defect?projectId=…`. The `count` field holds the number of affected test cases |
| Defect counters | `GET /api/rs/defect/{id}/testresult?size=1` and `GET /api/rs/defect/{id}/launch?size=1`, reading `totalElements` |
| Defect matchers | `GET /api/rs/defect/{id}/matcher` |

Pages are requested 1000 items at a time. At most 8 requests to Allure TestOps run concurrently.

## Limitations

- **Defect creator.** The Allure TestOps API does not return who created a defect. Matchers do have an author, so the author of the defect's earliest matcher is taken as the defect creator and marked "(matcher)" in the UI. This is an approximation: someone else may have added the matcher later. Defects without matchers stay under "(creator unknown)". If the server starts returning `createdBy` in the defect list, that value wins.
- **Cost of defect details.** Matchers, test results and launches take three requests per defect. On an instance with thousands of defects a crawl takes noticeable time, so defect auto refresh is off by default.
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
