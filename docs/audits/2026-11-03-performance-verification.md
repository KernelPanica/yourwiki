# YourWiki TypeScript v2 performance verification — 2026-11-03

The universal **whole page ≤500 ms target is not met**. In the controlled synthetic run, 12 of 40 navigations exceeded 500 ms. PDF first-page readiness had a 1,133.7 ms cold median and 843.7 ms warm median. Actual Redmi Note 12T and iOS acceptance remains untested.

## Reproduction and scope

Build the current sources, then run:

```bash
npm run build --prefix apps/web
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/path/to/chrome \
YOURWIKI_PERFORMANCE_PYTHON=/path/to/python-with-playwright \
YOURWIKI_PERFORMANCE_REPORT=/tmp/yourwiki-performance.json \
tools/performance-run.sh
```

The runner requires Linux with a working user systemd manager. It creates a disposable scope and verifies the server's actual `cpu.max=200000 100000` (2 CPU quota) and `memory.max=4294967296` (4 GiB). It fails if those limits cannot be verified. Direct execution of `apps/web/test/browser/performance.py` is also possible without the wrapper, but does not assert these limits. The server binds only to loopback and owns a temporary disk-backed SQLite/WAL database and blob directory. All documents and sessions are synthetic; no production credentials or provider calls are used.

The successful measured run used `main-75QEVP7Q.js`, `main-QD4GVTVO.css`, Node 26.10.0, and the existing Chromium binary at `/tmp/yourwiki-playwright/chromium-1234/chrome-linux64/chrome`. Raw resource timings and navigation samples are in `/tmp/yourwiki-performance-2cpu-4g-valid.json`; the complete 40 readiness samples are retained below. This is a development-host quota test, not a deployment acceptance result. A 2 CPU quota does not reproduce a particular server CPU's clock or contention.

Only the native application server and its in-process SQLite were inside this quota. Browser and load generator ran outside it. No live Collabora, Google integration, conversion workload, content uploads/edits, history restore or password hashing was measured. Browser navigation does write ordinary visit metadata. The fixture prepares 100 Markdown documents and one single-page PDF form before timing; each library request returns the API's first 50 items with a continuation cursor. Large documents, deeper permissions/folders, and long sessions are outside this run.

## Whole-page readiness and network

Each full navigation starts its clock at Navigation Timing zero and waits for authenticated page data, loaded document font set, header controls and two animation frames. Library search is exercised after readiness to prove its React handler works. Account requires its populated details. Markdown requires the preview iframe's complete document, heading and fonts. PDF requires its prepared first-page canvas and annotation form plus an enabled zoom control; the harness verifies the field is editable. These are content-readiness timings, not HTML response time, FCP or a loading placeholder.

Cold means the browser HTTP cache was cleared before each navigation; server, database and generated previews were already warm. It does not mean a fresh OS/browser process, empty DNS cache or newly generated preview. Warm means another full navigation retaining the HTTP cache; authenticated API data is still fetched.

The browser uses desktop Chromium, a 393×852 viewport and 4× CPU slowdown. **This is not a measured Redmi, Android browser or iOS Safari.** Nominal latency is 40 ms with CDP `Network.emulateNetworkConditions` on each page target, at 125,000,000 bytes/s upload/download (1,000 Mbit/s). Real transport is loopback HTTP: no TLS, remote DNS, radio or WAN. Worker-target requests may not inherit page-target CDP emulation (the sampled PDF worker response was shorter than 40 ms). Background API load is unthrottled loopback. Consequently these results are optimistic proxies, not a verified 40 ms end-to-end mobile connection.

## Measured readiness under 15 authenticated users

Five samples per cell; nearest-rank p95 equals the maximum with this small sample size and is not a population p95 estimate.

| Page | Cache | Median, ms | Max / sample p95, ms | Samples >500 ms |
|---|---|---:|---:|---:|
| Library | Cold | 360.2 | 536.4 | 1/5 |
| Library | Warm | 280.0 | 288.0 | 0/5 |
| Account | Cold | 308.0 | 427.1 | 0/5 |
| Account | Warm | 194.4 | 237.9 | 0/5 |
| Markdown preview | Cold | 398.9 | 579.8 | 1/5 |
| Markdown preview | Warm | 340.5 | 373.8 | 0/5 |
| PDF canvas/form/controls | Cold | 1,133.7 | 1,506.4 | 5/5 |
| PDF canvas/form/controls | Warm | 843.7 | 861.4 | 5/5 |

## Server read workload

Fifteen distinct authenticated users repeatedly read account, the first library page, a rotating Markdown document view and its primary preview asset, then wait 250 ms. Authentication identity and returned content are checked. The measured browser shares user 0, keeping 15 distinct identities. This is API workload concurrency plus one browser, not 15 simultaneously rendering browser instances or 15 live office sessions.

The successful run sustained **3,680 requests in 25.37 seconds (145.1 requests/s)** with zero HTTP, identity/content assertion or browser script errors. All four endpoint groups had 920 successful requests.

| HTTP endpoint group | Median, ms | p95, ms | Max, ms |
|---|---:|---:|---:|
| Account | 6.5 | 19.3 | 24.5 |
| Library first page | 47.3 | 91.2 | 398.9 |
| Document view | 68.0 | 121.4 | 435.4 |
| Primary prepared preview | 22.2 | 58.9 | 91.5 |

The server used 11.62 CPU seconds during the measured load interval (~45.8% of one CPU on this host), final process RSS 245.4 MiB, process max RSS 245.4 MiB, and recorded cgroup memory peak 202.5 MiB. RSS includes shared pages and differs from cgroup accounting. Scope OOM/max-memory events were zero. These are short synthetic read-path observations; they do not establish full-stack 2 CPU/4 GiB capacity or a sustained production service level.

## Evidence for remaining bottlenecks

The sampled median cold library navigation transferred 459,307 resource bytes as reported by browser Resource Timing (including resource response headers). Its font alone was 352,240 payload bytes. The current font is already WOFF2; it dominates this high-bandwidth cold path.

The median cold PDF navigation transferred 1,038,862 reported resource bytes. Its account response completed at 276 ms, view metadata at 330 ms, lazy PDF wrapper at 381 ms and PDF library chunk at 432 ms. PDF CSS was requested only at 642 ms and finished at 713 ms; PDF state finished at 789 ms, the hash dependency at 840 ms, the worker at 908 ms, content at 1,016 ms and readiness at 1,134 ms. This is direct evidence of a PDF initialization/request waterfall and main-thread work; it is not evidence that server response time alone explains PDF readiness. Its largest observed cold long task was 115 ms. Reducing this path requires measured changes to lazy dependency scheduling/CSS/worker/content startup without eagerly fetching PDF for every library visit.

The HTML now preloads the transitive **static** entry-module graph once, excluding dynamic editor imports, external modules and stylesheets. Tests cover shared dependency deduplication, cycles, missing graph entries and optional/external exclusion. A mutation removing external exclusion made the test fail; restoring it passed. Browser library traces contain no PDF runtime/worker/CSS requests. This prevents optional editor fetching from being introduced by the preload change. No before/after speedup is claimed: the initial baseline already contained this deliberate preload work.

## Verification and remaining acceptance

`npm run build --prefix apps/web`, `npm run typecheck --prefix apps/web`, and all 29 web test files passed. Python compilation and the benchmark's authenticated content, editable PDF controls, search-handler and script-error checks passed. This document records the measured build above; rerun the same harness after integrating further source changes.

Actual Redmi Note 12T and iOS Safari must be measured with the same complete-content criteria, cold/warm cache distinction, a stated real connection/RTT, and the intended deployment stack. Google/Collabora and conversion contention need separate capacity measurements. Until that evidence exists and the PDF path improves, a whole-page ≤500 ms guarantee is unsupported.

## Readiness samples, milliseconds

| Page | Cache | Samples in run order |
|---|---|---|
| library | cold | 536.4, 405.1, 360.2, 329.4, 327.0 |
| library | warm | 288.0, 254.3, 255.0, 280.0, 287.8 |
| account | cold | 427.1, 270.9, 271.5, 308.0, 342.5 |
| account | warm | 225.1, 191.2, 194.4, 193.7, 237.9 |
| document | cold | 579.8, 473.5, 391.8, 398.9, 390.2 |
| document | warm | 373.8, 337.2, 340.5, 359.2, 311.8 |
| pdf | cold | 1506.4, 1133.7, 1155.1, 1103.4, 1083.2 |
| pdf | warm | 861.4, 816.4, 853.7, 836.6, 843.7 |


Final integrated build rerun (2026-11-03 deadline batch): enforced2CPU/4GiB;15users;3600HTTP requests in23.13s (155.7req/s),0errors. Whole-page cold/warm medians: library335.2/239.4ms, account275.7/192.0ms, Markdown374.5/294.1ms, PDF1035.4/821.8ms. Eleven of40navigations exceeded500ms. Same desktop Chromium/CDP limitations as above; no physical Redmi/iOS certification or Collabora load certification. Raw report: /tmp/yourwiki-deadline-performance.json.
