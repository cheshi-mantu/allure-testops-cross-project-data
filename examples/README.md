# Examples

Standalone scripts that read Allure TestOps through its public REST API. They need Node.js 18 or newer and nothing else: no `npm install`, no build.

## Initial success rate of a launch

`initial-success-rate.mjs` measures how well the automation does on its own, before anyone reruns failed tests by hand.

```
initial success rate = automated tests whose initial attempt passed / all tests in the launch (automated + manual)
```

- Every test of the launch counts once, however many attempts it has.
- The initial attempt of a test is its first attempt in the launch, before any rerun.
- Manual tests count in the denominator only: when the first automated run is over they have not been executed yet.

Run it with the launch to measure:

```bash
ALLURE_TOKEN=<api token> node examples/initial-success-rate.mjs --endpoint https://testops.example.com --project 1 --launch 1234
```

`--token` can be passed instead of `ALLURE_TOKEN`, and `ALLURE_ENDPOINT` instead of `--endpoint`. The token owner needs read access to the project.

Output:

```
Launch                            1234 Release 1.1
Tests in the launch               5
  automated                       4
  manual                          1
Automated tests rerun             2
Initial status of automated tests
  passed                          1
  failed                          2
  broken                          1
  skipped                         0
  unknown                         0
Initial success rate              20.00 %  (1 of 5)
Current success rate              60.00 %  (3 of 5, visible results)
```

The current success rate is the share of passed visible results among all tests of the launch, the way the launch looks now, for comparison.

### How it works

A launch keeps one visible result per test: its latest attempt. When a test is rerun, its earlier attempts become hidden.

1. All visible results of the launch, the denominator: `GET /api/rs/testresult/__search?projectId=&rql=launch = <id> and hidden = false`.
2. Visible automated results: the same with `and manual = false`.
3. Hidden results of the launch, `and hidden = true`; their test case IDs are the tests that were rerun.
4. For an automated result of a rerun test, its earlier attempts in the launch: `GET /api/rs/testresult/{id}/retries`. The oldest of them is the initial attempt. For a test that was not rerun the visible result is the initial attempt. So earlier attempts are read only for rerun tests.
5. The initial attempts that passed, divided by the number of tests in the launch.

All pages of every answer are read. The API token is exchanged for a bearer token once per run (`POST /api/uaa/oauth/token`), with the token itself as a fallback. Reads that fail with a server error, or are answered with a web page instead of JSON, are repeated.

Notes:

- An automated result without a test case cannot be matched with the hidden results: its earlier attempts are always read, and the output mentions how many such results there are.
- A parameterized test case can have several results in one launch. When one of them was rerun, the earlier attempts of the others are read too, and they come back empty.
- `GET /api/rs/launch/{id}/progress` tells whether the launch is still processing uploads; the script warns then, because the numbers may change.
- A launch without tests gives no rate instead of a division by zero.
- `GET /api/rs/testresult/{id}/history` does not help here: it returns results of earlier closed launches only.
