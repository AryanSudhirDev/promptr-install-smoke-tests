# Promptr install monitoring: how it works and how to change it

Two independent monitors continuously verify that the published Promptr extension
(Open VSX `aryansudhir.promptr`) installs and works on a fresh machine. They share the same
test harness and the same idea (date-seeded plan, half-hour slots, catch-up, ledger) but run
on different infrastructure from different networks.

| | GitHub monitor | iMac monitor |
|---|---|---|
| Where it runs | GitHub-hosted `ubuntu-24.04` VMs (new VM per check) | Colima Linux VM on the 2017 iMac, new Docker container per check |
| Daily volume | 70-90 (varies by date seed) | 100 (fixed, `DAILY_TOTAL`) |
| Slot times (UTC) | :07 and :37 every hour (48 slots) | :22 and :52 every hour (48 slots) + random 0-8 min delay |
| Max per run / parallel | 8 per run, 2 VMs at a time | 6 per run, 3 containers at a time |
| VS Code | downloaded fresh per check | pre-installed in the container image |
| Promptr VSIX | downloaded from Open VSX per check | downloaded from Open VSX per check |
| Trigger | iMac curls GitHub every 30 min (+ GitHub cron as fallback) | launchd on the iMac every 30 min |
| Code | `github-monitor/` (git clone of `AryanSudhirDev/promptr-install-smoke-tests`) | `imac-monitor/` (mirror of `/Users/Aryan/promptr-qa/monitor` on the iMac) |
| Results | Actions tab, per-run summary + artifacts (2-day retention) | `~/promptr-qa/monitor/reports/<slot-id>/`, `history.jsonl`, `logs/monitor.log` |

Both count toward Open VSX's public download number (every successful VSIX fetch counts).
Combined that is roughly 170-190 downloads/day from your own monitoring.

---

## 1. What one check does (identical on both)

1. Start from a clean environment: no VS Code user data, no extensions directory, no settings.
   The harness asserts this before doing anything.
2. Ask Open VSX for the current published release (`GET /api/aryansudhir/promptr`), fetch the
   registry's SHA-256, download the VSIX, verify the hash matches.
3. Verify the VSIX manifest: id `aryansudhir.promptr`, version matches the registry, `main` is
   `./dist/extension.js`, has a VS Code engine range, activates `onStartupFinished`.
4. Install with `code --install-extension` into fresh `--user-data-dir` / `--extensions-dir`.
   Confirm it is listed at the expected version.
5. Variant-specific lifecycle: `reinstall` (uninstall, reinstall, confirm), `duplicate-install`
   (install again, confirm exactly one listing).
6. Launch VS Code under Xvfb with a tiny helper extension that runs `extended-suite.cjs` inside
   the extension host: extension discovered, activated, 4 commands registered
   (`promptr.generatePrompt`, `setTemperature`, `setCustomContext`, `enterAccessToken`),
   keybinding `shift+ctrl+g` / `shift+cmd+g`, settings defaults (`temperature` 0.3,
   `customContext` ""), settings round-trip, configuration keys present. `ui-settings` also
   takes a screenshot.
7. Write `download.json`, `installation.json`, `checks.json`; then everything is destroyed
   (VM decommissioned / container removed).

Variants cycle through: `manifest`, `clean-state`, `settings-isolation`, `ui-settings`,
`reinstall`, `duplicate-install`.

No Promptr access token, no paid AI requests, no production credentials are used.

---

## 2. The plan, slots, catch-up, and ledger

- **Date seed.** The UTC date string is hashed (FNV-1a) to seed a small PRNG, so a given day's
  plan is identical no matter which machine or how many times it is computed, and it changes
  every day.
- **Slots.** The day is split into 48 half-hour slots. Every slot gets at least 1 check; the
  remaining `total - 48` are sprinkled randomly, so most slots have 1-3 (iMac: 1-5).
  Slot ids look like `20260907-s1437-01` = date, slot `14:37` UTC, check index.
- **Due = slot time has passed, within the lookback window (6 h), and not yet attempted.**
- **Catch-up.** Every run computes the due set and runs it, capped per run (GitHub 8, iMac 6).
  If a trigger is late or the machine was off, the backlog drains a few at a time over the
  following runs rather than as one burst. Slots older than the lookback are skipped for good.
- **Ledger.**
  - GitHub has no state file: the plan job lists the last 24 runs of the workflow and reads the
    slot ids out of their job names. A slot counts as attempted if any job for it exists
    (pass or fail), so failures are never retried in a loop.
  - iMac keeps `~/promptr-qa/monitor/attempted.json` (written before containers start, so a
    crash can't cause re-runs) and appends one line per run to `history.jsonl`.
- **Concurrency guard.** GitHub uses a `concurrency` group so two runs never overlap. On the
  iMac, launchd never starts a second instance of the same job while one is running.

---

## 3. GitHub monitor

Repo: https://github.com/AryanSudhirDev/promptr-install-smoke-tests
Workflow: `.github/workflows/daily-health-qa.yml` ("Promptr install reliability monitor")
Actions page: https://github.com/AryanSudhirDev/promptr-install-smoke-tests/actions/workflows/daily-health-qa.yml

Jobs in one run:
1. `plan` - checks Open VSX is reachable and resolves the release once (if the registry is down
   the run exits quietly with no test jobs), computes due slots, emits a matrix.
2. `test` (matrix) - one job per due check on a fresh `ubuntu-24.04` VM. Installs Xvfb + deps,
   downloads VS Code stable, runs `extended-run-test.cjs`, uploads `results/` as an artifact,
   wipes the workspace.

Triggers:
- `schedule: '7,37 * * * *'` (GitHub's cron; best-effort, often late or dropped).
- `workflow_dispatch` - what the iMac calls every 30 min via `~/promptr-qa/trigger-monitor.sh`
  using a fine-grained token (`~/promptr-qa/github_token`, Actions read/write on this repo only,
  **expires 2026-12-06**: create a new one at github.com/settings/personal-access-tokens and
  overwrite that file).
- Manual: Actions tab > Run workflow. `force_count=N` runs N checks immediately regardless of plan.

### Changing the GitHub volume
Edit the workflow (web editor: append `/edit/main/.github/workflows/daily-health-qa.yml` to the
repo URL, or edit `github-monitor/` here and `git push`). Inside the `NODE` heredoc:

```js
const total = 70 + Math.floor(random() * 21);   // daily total: MIN + random*(MAX-MIN+1)
```
- exactly 100/day: `const total = 100;`
- 90-120/day: `const total = 90 + Math.floor(random() * 31);`
- fewer than 48/day: also change `Array(48).fill(1)` to `fill(0)`, otherwise every slot forces 1.

Other knobs:
- `const maxCatchUpJobs = 8;` max checks per run (raise if you raise total a lot).
- `const maxLookbackHours = 6;` how far back missed slots are recovered.
- `max-parallel: 2` VMs at once (Pro plan cap is 40).
- Slot minutes: `'07'`/`'37'` in the planner and the cron line; keep them in sync with the
  iMac trigger plist if you change them.
- Variants: the `variants` array. Adding one needs a matching case in `extended-suite.cjs`.

The next trigger uses the new file automatically. Changing `total` reshuffles the per-slot
assignment for the rest of the day, which is harmless.

### Reading results
Each run's summary lists the release tested (version + sha256), which slots were due, and the
per-check outcomes. Artifacts `install-check-<run>-<slot-id>` hold the JSON reports and
screenshots for 2 days.

---

## 4. iMac monitor

Live location on the iMac: `/Users/Aryan/promptr-qa/`
```
monitor/monitor.mjs        planner + scheduler (runs due checks as containers)
monitor/run-monitor.sh     launchd entry: random delay, start Colima if needed, run monitor
monitor/image/             Dockerfile, entrypoint.sh, container-check.cjs, extended-suite.cjs, helper/
monitor/reports/<slot>/    download.json, installation.json, checks.json, container.log
monitor/attempted.json     ledger      monitor/history.jsonl   one line per run
trigger-monitor.sh         curls GitHub to dispatch the GitHub monitor
github_token               fine-grained token (mode 600, never copy elsewhere)
logs/                      monitor.log, trigger.log, colima-start.log, launchd outputs
```
launchd agents (`~/Library/LaunchAgents/`):
- `dev.aryansudhir.promptr-qa-monitor.plist` - :22 and :52 every hour
- `dev.aryansudhir.promptr-qa-trigger.plist` - :07 and :37 every hour (GitHub dispatch)

Tooling (installed without admin rights): `~/.local/bin` (colima, docker, node, npm),
`~/.local/lima`, Docker Compose plugin in `~/.docker/cli-plugins`. In any shell on the iMac:
```
export PATH="$HOME/.local/bin:$HOME/.local/lima/bin:$PATH"
```
Colima VM: `colima start --vm-type vz --cpu 4 --memory 6 --disk 10` (Apple Virtualization
framework; works on this Intel/Ventura machine). `run-monitor.sh` starts it if it is down.

### Changing the iMac volume
Edit `monitor.mjs` (on the iMac, or edit `imac-monitor/monitor.mjs` here and sync):
```js
const dailyTotal = Number(process.env.DAILY_TOTAL || 100);   // checks per day
const concurrency = Number(process.env.CONCURRENCY || 3);    // containers at once (VM has 4 CPUs / 6 GB)
const maxLookbackHours = 6, maxPerRun = 6;                   // catch-up window and cap per run
```
- Below 48/day also change `Array(48).fill(1)` to `fill(0)`.
- More often than every 30 min: add entries to the monitor plist and reload it.
- Slot minutes `'22'`/`'52'` are set in the planner; keep them offset from GitHub's :07/:37.

Sync and reload from this Mac:
```
rsync -av --exclude reports --exclude attempted.json --exclude history.jsonl --exclude launchd \
  ~/Developer/promptr-qa/imac-monitor/ imac:~/promptr-qa/monitor/
scp ~/Developer/promptr-qa/imac-monitor/launchd/*.plist imac:~/Library/LaunchAgents/
ssh imac 'launchctl bootout gui/$(id -u)/dev.aryansudhir.promptr-qa-monitor; launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/dev.aryansudhir.promptr-qa-monitor.plist'
```
(`ssh imac` works from this Mac: alias in `~/.ssh/config`, key `~/.ssh/imac_ed25519`.)

### Rebuilding the container image
Needed after editing anything in `image/` (e.g. new VS Code channel, harness change):
```
ssh imac
export PATH="$HOME/.local/bin:$HOME/.local/lima/bin:$PATH"
cd ~/promptr-qa/monitor/image && docker build -t promptr-install-check:local .
```
About 3-4 minutes. The image has no Promptr artifact in it, so a new Promptr release needs no
rebuild; every check resolves the current version from the registry.

### Useful commands on the iMac
```
launchctl kickstart gui/$(id -u)/dev.aryansudhir.promptr-qa-monitor   # run the monitor now
tail -f ~/promptr-qa/logs/monitor.log                                   # watch it
docker ps                                                               # running checks
colima status / colima start / colima stop
node -e "console.log(require('/Users/Aryan/promptr-qa/monitor/attempted.json'))" | tail
```

### Reboots
System sleep is disabled and auto-restart after power loss is on. After a reboot the iMac
waits at the login screen (FileVault is on); the agents start once you log in. Missed slots
within the 6-hour lookback are then caught up a few per run.

---

## 5. Daytona (paused)

`daytona-checks/` is a standalone Docker coordinator that runs clean-install checks in
disposable Daytona sandboxes from a VSIX fetched once per batch (sandboxes on Tier 1/2 cannot
reach Open VSX, so they don't count as registry downloads). Snapshot `promptr-install-check-v1`
exists on the Daytona account. Needs a `.env` with `DAYTONA_API_KEY`. The GitHub workflow
`daytona-install-checks.yml` for the same thing is disabled. Roughly $0.0005 per check.

---

## 6. Ground rules (keep these)

- Every check must do real verification: download + hash, install, activation, assertions.
  Do not reduce a check to "download only".
- Daily volume is owner-set and is not an agent's call. The iMac plans 3000 Promptr + 2000
  CogniSpec checks/day and the MacBook is capped at the same pair. Never lower these values, add a
  tighter clamp, or restore an older number on your own initiative; report concerns instead. This
  replaces the former "keep registry traffic in the low hundreds per day" rule. Rationale, all six
  locations and the safe change order: "Daily QA volume policy" at the end of this file.
- Open VSX counts CI fetches in the public download number; the README and the dashboard footer say
  so. Keep that disclosure accurate rather than reducing verification to hide traffic.
- Do not route traffic through proxies/VPN rotation to obscure the source.
- Never commit `github_token`, `.env`, or `imac_ed25519`.
- If GitHub ever emails about Actions usage, reply promptly with the QA repo README.

## iMac scheduler v2 (2026-09-09)

Source: `imac/`. Deployed under `~/promptr-qa/monitor` on the iMac.

- The iMac dashboard accepts 1–8000 checks/day; GitHub remains capped at 1000. The host reads the existing repo setting every invocation.
- Five-minute slots at :02/:07/.../:57, 288 per UTC day. Exact total uses cumulative integer allocation, so 780 means 2–3 checks per slot, not six per half-hour.
- Maximum three concurrent containers. Launchd prevents overlapping service runs; a PID lock also protects manual invocations.
- Durable per-job queue (`scheduler-v2.json`): max 100 jobs or 20 minutes of new starts per invocation; untouched jobs remain pending. Started jobs are not retried automatically after interruption.
- Six-hour catch-up window. Expired jobs and missed scheduling slots are explicitly counted, not claimed as passes. Seven-day scheduler-state retention; per-job reports remain on disk.
- Setting changes apply to future slots after the next configuration read. A partial day is prorated, not backfilled to the new daily total.
- Migration starts at the current slot; the previous capped runner's skipped jobs are not replayed.
- Installation success requires the extension-test success marker, not just a successful container exit.
- Local `status-v2.json` and `history.jsonl` expose passed/failed/pending/expired/interrupted counts. Hosted dashboard still lacks the iMac heartbeat and must not infer health from a setting.
- Pre-migration runner and plist backed up at `~/promptr-qa/monitor/backups/pre-v2/`.
- Regression: `npm run test:dashboard` includes every allowed iMac total from 1 through 8000, changes, midnight rollover, batch caps, and expiration, without running containers or downloading the extension.

### iMac ceiling increased to 8,000 (2026-09-09)

Only the accepted configuration range changed; current rate remains 780/day. A full 8,000/day plan has 27–28 jobs in each five-minute slot. Three-container concurrency, bounded queues, the six-hour catch-up window, and per-container fresh Open VSX downloads are unchanged. No artifact caching was deployed. This is a software ceiling, not a hardware throughput certification: 8,000/day has not been load-tested, and slower runs may queue or expire.

## Three-command coverage and report compression (2026-09-09)

The iMac mounts the repository-tracked `imac/extended-suite.cjs` read-only into each fresh container. It verifies declaration and registration of `generatePrompt`, `setTemperature`, and `setCustomContext`; it no longer explicitly verifies `enterAccessToken`. Every report lists this coverage omission. Installation, activation, settings, shortcut and variant checks are retained, as is a fresh registry download per container. Reducing name checks is not expected to materially lower CPU/RAM.

`imac/archive-reports.mjs` compresses completed reports older than 24 hours, grouped by Pacific completion day. It extracts each generated archive into a temporary directory, compares all file sizes and SHA-256 hashes, rechecks the source, writes a manifest, then removes only verified source folders. Active/recent/unrecognized reports and scheduler ledgers stay untouched. Copies of older VS Code logs sometimes have write-only owner permissions; archival adds owner-read permission only where needed. Symlinks cause safe failure without deleting originals.

Archives and per-file manifests live at `~/promptr-qa/monitor/archives/`. The `dev.aryansudhir.promptr-qa-archive` LaunchAgent runs at 03:10 local Pacific time. Archival has a separate lock and leaves source reports intact on failed verification. It does not compress the active job ledger, change rates, or alter downloads.

First verified pass: 352 completed reports, 10,977,546 source bytes to 5,080,283 archive bytes (about 54% smaller, excluding manifest overhead). A separate fresh-container verification confirmed the three-command suite, fresh VSIX download and extension activation passed.

## Hard-deadline recovery (2026-09-12)

A UI test completed its assertions at 09:12 PDT but the VS Code main process stayed open. The original `execFile` timeout sent SIGTERM and waited for Docker/its pipes to close, so the scheduler stayed blocked for hours. Its report and recovered container log were preserved; the container was force-removed and its job recorded as interrupted. The scheduler then adopted the dashboard's 1400/day setting.

`imac/exec-bounded.mjs` uses a dedicated process group, a hard wall-clock timer, SIGKILL escalation on failure, bounded output, and independent promise settlement so ignored signals/inherited pipes cannot block the queue. Each test now has five minutes; cleanup gets 20 seconds. Cleanup failure stops new starts and is retried next invocation. Docker readiness and Colima startup are also bounded and happen after reading configuration. The launcher preserves Node's error exit status. Status updates publish after every completed test, not only at batch end.

`MAX_JOBS_PER_RUN=6 node monitor.mjs` was used once for recovery validation: 6 passed, 0 failed. Default remains 100 jobs per invocation, three concurrent, with a 20-minute new-start budget and normal five-minute launchd scheduling. Regression tests explicitly cover ignored SIGTERM and grandchildren holding output pipes open.

## Shared Open VSX request pacing (2026-09-13)

The iMac now mounts `imac/container-check.cjs` and `imac/registry-fetch.cjs` read-only. All its metadata, checksum, VSIX, redirect and retry GETs acquire one shared filesystem mutex at `~/promptr-qa/monitor/registry-limit/`. A requester retains the mutex through the response body and persists the next allowed time 650 ms after completion. This intentionally stays below two requests per second across the iMac QA containers, rather than allocating two requests per second to each container. Only pacing/cooldown metadata is shared: there is no artifact cache, shared VSIX, shared VS Code profile, or reused test environment. Other applications on the same network and GitHub-hosted runners are outside this local limiter.

Redirects are followed manually through the same gate; only HTTPS on the observed Open VSX registry/file hosts (`open-vsx.org`, `openvsx.eclipsecontent.org`) is accepted. Unexpected hosts fail closed. Responses are capped at 32 MiB. Each response, including its body, has a 30-second deadline, and a logical fetch has a 120-second budget. The outer five-minute container deadline remains.

HTTP 429 and 503 trigger shared cooldowns. Retry-After delta-seconds and HTTP dates are respected with positive-only jitter, with exponential fallback when absent/invalid. No logical request gets more than two throttling retries (three attempts), with at most five redirects. Long server waits are never shortened to fit the test budget: the test records a cooldown error, and the monitor stops starting more work while the shared cooldown remains. Unstarted checks remain queued under the existing six-hour window. No rate or concurrency increase was made: 1400/day, three containers maximum.

Containers never steal a stale mutex by PID or lease age. On a killed mutex holder, the batch stops new starts; existing requests fail closed within their bounded wait. The host may remove the orphan mutex only after cleanup and a Docker check confirms no prior `promptr-check-*` containers remain. Cooldown state survives both process restarts and this recovery. Corrupt state stops the monitor instead of resetting its limits.

Per-check `registry-requests.jsonl` records request starts, body completion, HTTP status, attempts and cooldowns alongside the existing download/hash and activation evidence; normal report archival includes these files. Automated tests cover independent child processes, redirects, shared/restarted cooldowns, bounded retries, malformed state, dead mutexes and stalled response bodies. A three-container mocked-registry integration test on Colima produced seven requests (one simulated 429), all with at least 651 ms between the previous response completion and next request start, without contacting Open VSX.

Live validation at 10:52 PDT: the first scheduled limited batch passed 5/5 at the unchanged 1400/day rate, with no pending jobs. Five distinct containers freshly downloaded 1,619,686-byte VSIX files; each SHA-256 matched its installation record and all activation suites passed. The per-check journals recorded 25 wire requests (15 HTTP 200 and 10 HTTP 302), with a minimum 650 ms completion-to-next-start gap. The batch finished in about 36 seconds. This also corrects the earlier estimate of three requests/check: that counted logical fetches only; the current release uses five wire requests/check including redirects.

## CogniSpec on the shared iMac (2026-09-13)

`monitor-config.json` now holds independent iMac QA targets: `imacDailyTotal: 1400` for Promptr and `cognispecDailyTotal: 1189` for CogniSpec, for 2589 planned fresh-install checks/day. These are QA attempts, not promised public counter increments. One monitor owns both queues and limits the combined workload to three containers. All registry requests from both targets use the existing shared 650 ms completion-to-next-start gate and persisted cooldowns. GitHub's separate 90/day Promptr plan is unchanged.

`imac/multi-plan.mjs` keeps the exact slot allocation independent. Promptr's existing job IDs and `scheduler-v2.json` are preserved; CogniSpec uses namespaced IDs in `scheduler-cognispec-v2.json`. A new CogniSpec plan starts with the current five-minute slot, without historical catch-up. Pending work is interleaved within matching slots, and stopping the optional CogniSpec target (`cognispecDailyTotal: 0`) cancels its unstarted work instead of replaying disabled intervals on re-enable. Existing rate changes remain forward-only. Both ledgers feed the same verified nightly report archive.

The common container harness selects only the allowlisted intended extension and verifies its identity/version, fresh VSIX absence before download, published checksum, clean profile, installation and lifecycle. CogniSpec has its own activation suite for its three command registrations and jsPsychVersion setting. Generated study execution/export correctness, research data, Cursor and native OS behavior are explicitly excluded. Production extension repositories are not modified.

The iMac had only about 7.6 GiB of disk free at setup, despite reasonable CPU/memory headroom. Before each new check, the runner now verifies at least 5 GiB of available disk. Below that floor it pauses new work and leaves pending jobs queued under the existing six-hour catch-up window. It does not delete user files or kill active checks. This safeguard is not a substitute for freeing disk space.

Initial standalone CogniSpec clean-install benchmark: 13.2 seconds, version 0.1.0, fresh 16,133-byte VSIX, SHA-256 a054f4cf4bef01fd42fc9e00bf87d37f2f81e22457328586310c6d8d712cf917, activation/settings/command checks passed. Benchmarked without changing the production extension repositories or making study execution/network calls. Full local regression suite: 51 passing tests.

Combined live validation, 11:07 PDT batch: 5 Promptr + 5 CogniSpec checks all passed in 68.1 seconds, across ten distinct fresh containers. Both targets overlapped in the same queue; reconstructed job intervals peaked at three concurrent jobs. All downloaded identities and installation hashes matched their intended target. The 50 wire requests were spaced at least 650 ms apart across both extensions. No backlog remained, with 7.59 GiB disk available. Evidence is retained in `backups/cognispec-combined-verification.json` on the iMac and the per-job reports. Regression suite now has 52 passing tests, including preservation of CogniSpec's rate when the existing dashboard changes Promptr's rate.

## Unified Promptr and Cognispec dashboard (2026-09-13)

The hosted dashboard now covers both published extensions from one page. It shows separate live Open VSX counters, versions and review counts, and side-by-side historical progression charts with no extension switcher. Promptr keeps the existing `downloads.jsonl` data path; Cognispec uses `downloads-cognispec.jsonl`. The legacy `status.openvsx` Promptr object remains for compatibility while `status.extensions` exposes both.

The settings API returns and writes `github`, `imac` (Promptr iMac), and `cognispec` (Cognispec iMac) independently. Changing one iMac target preserves the other target's field. GitHub-hosted checks remain Promptr-only at the existing configured rate. The dashboard's combined value sums all configured targets and labels the GitHub card accordingly. Cognispec can be set to zero to disable its iMac checks without deleting its history.

The iMac execution design is unchanged: Promptr and Cognispec share one three-container maximum, one Open VSX request limiter, separate scheduler ledgers, fresh download/container/profile per check, and the existing disk safety floor. Dashboard display does not claim iMac execution health because the hosted publisher has no direct iMac telemetry; the iMac cards explicitly show configuration only. The full local regression suite covers both live counters, separate histories, chart switching, independent setting saves and preservation, and contains 55 passing tests at this change.


## Responsive daily dashboard redesign (2026-09-13)

Reorganized the page into one panel per extension, with each counter shown once, distinct teal/violet chart colors, recent-change windows, hourly observations and a clearly labeled linear scenario. The daily targets sit in one compact strip below both panels. Access-key management uses a small disclosure, and detailed runner telemetry/source explanations remain available under Runner details & chart guide. The default desktop view fits at 1440x900, 1366x768, 1280x800 and 1024x768 without cropping content or disabling scrolling. Below 640 px, the panels stack naturally, with 44 px or larger rate-input/save targets, 16 px number inputs, tap-readable chart tooltips and no horizontal overflow. Phone viewing intentionally scrolls vertically rather than shrinking charts into unreadable tiles.

The design follows the system light/dark preference and reduced-motion preference. Both history and hourly charts retain keyboard controls. Tooltip labels now use actual newlines; redraws remain isolated by extension. Fallback metadata retains its version string when live registry reads fail. The visible footer explicitly warns that registry counters can lag and include QA traffic; no upstream caching fix or monitor-rate change is claimed.

Validation: `npm run test:dashboard` passes 58 tests. `npm run test:layout` adds a real Chromium test matrix at ten viewport/theme combinations, including 320/360/390 px phones, tablet and desktop sizes. Four light/dark desktop/phone axe-core scans check WCAG A/AA rules with no violations found. All non-local requests in this browser suite are mocked; the save-flow check uses a dummy key and never calls a production write endpoint. CI now installs the pinned Playwright Chromium build and runs this suite. For a preinstalled browser, use `CHROME_BIN=<absolute Chrome executable> npm run test:layout`; optional `LAYOUT_SCREENSHOT_DIR` captures temporary test evidence. Local macOS sandbox prevented a new headless Chrome launch, so the same test was run in an isolated temporary directory on the iMac, outside the live QA monitor and without changing its settings.

## Measured iMac efficiency audit (2026-09-14)

Hardware inspected: iMac18,2, Intel i5-7400 (4 cores), 16 GiB host RAM. Colima uses four CPUs and approximately 6 GiB RAM, with three 2 GiB-capped containers. These are Linux VS Code checks hosted on an iMac, not native macOS VM tests. VS Code and the harness are already baked into the image; there is no editor download or package-manager setup per check.

A rolling 24-hour ledger sample contained 1,400 Promptr attempts (1,391 passed) and 1,189 CogniSpec attempts (1,187 passed), averaging 18.46 and 18.53 seconds respectively. Ten failures were network timeouts and one was a VS Code SIGSEGV. A nearby 288-batch sample had median 58.91 seconds and p95 70 seconds for mostly nine checks per batch. This is low-duty-cycle observational evidence, not certification of any higher daily rate.

Optimization: `imac/install-lifecycle.cjs` removes two redundant VS Code CLI extension-list probes per successful job. The old assertion message eagerly launched a second list even on success; the final report also re-listed unchanged state. The last verified listing is now reused for messages/reporting only. Every initial, uninstall, reinstall, and duplicate-install state transition retains its own real CLI verification. CLI launches are 6→4 for ordinary variants, 10→8 for reinstall, and 8→6 for duplicate-install. The host mounts the helper read-only alongside `container-check.cjs`. All deployments of the new container harness must also deploy and mount this helper.

The harness now writes `timings.json` with registry, artifact verification, profile setup, CLI lifecycle, activation-suite and log-collection durations plus per-command timings, including a failed status and unfinished-stage time if a stage fails. This adds evidence without lowering test coverage or adding retries.

Benchmark: 36 fresh containers, two extensions × six variants × three configurations, using the current production image and 3-way concurrency. Input VSIXs were captured read-only from already-scheduled successful checks; no extra public downloads were made. Every benchmark container used `--network=none`, diagnostic-only fixture loading, and separate output directories. The scheduler's exclusion lock prevented overlap with normal QA; its schedules and ledgers were not changed. All 36 runs passed, and all 24 baseline-versus-candidate report comparisons retained identical suite coverage and artifact hashes.

| Configuration | Runs | Mean seconds/check |
| --- | ---: | ---: |
| Original harness | 12 | 15.260 |
| Redundant CLI removal | 12 | 14.701 |
| CLI removal plus 256 MiB RAM-backed profile | 12 | 14.570 |

The adopted change saved 0.559 seconds/check (3.66%) in this small, interleaved, offline comparison. RAM-backed profiles added only 0.131 seconds average benefit and were not deployed. These results exclude public-registry latency and do not imply a sustainable maximum checks/day. Raw rows are in `benchmarks/imac-efficiency-20260914.json`; full diagnostic reports remain under `~/promptr-qa/efficiency-audit-20260914/` on the iMac. Offline runs are not public fresh-download checks, are not written into QA ledgers, and must never be counted as users or installs.

No change to `monitor-config.json`, daily totals, three-container concurrency, 650ms completion-to-next-request spacing, cooldowns, fresh public-download rules, process timeouts, five-GiB disk floor, report retention, or archive verification. A measured throughput limit would require a longer representative soak test; the earlier 9k–10k/day and fleet 26.5k/day figures were extrapolations, not validated capacity or registry traffic allowances. For greater QA coverage without increasing public-registry load, maintain separate offline compatibility/regression tests against the verified release artifact, while keeping the true fresh-download monitor independently labeled.

## Activation-wait trim and MacBook assessment (2026-09-14)

Both activation suites now use `wait-for-setting.cjs` after awaited settings writes instead of unconditionally sleeping 200ms per write/reset. The effective setting is reread at up to 20ms intervals, with a two-second failure deadline. Original value assertions remain after the readiness check; configuration read/write errors still fail. Both extensions still activate in a real fresh VS Code process on every full check. The 30-second activation timeout is a ceiling, not a mandatory delay, and is unchanged. The 1.5-second command-palette screenshot wait remains limited to the UI variant. Deploy and mount `wait-for-setting.cjs` together with the two suites and the updated monitor.

MacBook inspection: Mac16,8, Apple M4 Pro with 14 cores (10 performance + 4 efficiency), 24 GB RAM, approximately 95 GiB disk free at inspection. Docker is installed but its daemon is stopped; the machine was on battery. No laptop workload or overnight schedule was started. The current iMac image's Microsoft apt source is explicitly `arch=amd64`; a laptop runner requires a separately built native ARM64 image and regression checks, not assumed performance under x86 emulation. A laptop job must be AC-powered, awake, bounded by a stop time, and account for user activity, storage headroom, and heat. It must share a coordinated registry budget with the iMac, not create a second independent 650ms limiter.

A capacity illustration, not a MacBook benchmark: four local verification workers averaging 15–25 seconds/test produce 576–960 tests/hour, or 4,608–7,680 over eight hours. This assumes continuous availability and excludes public-registry queueing, retries, or a provider traffic allowance. A lighter install-only check would skip real activation and must have distinct coverage labels and counters; it must never be reported as a full activation pass. No installation-only mode or daily-rate increase was deployed.

Readiness comparison: 24 network-disabled fresh-container runs (two extensions × six variants × old/readiness suites), at two-way concurrency. All passed; all 12 paired `checks.json` reports matched exactly. Mean check runtime was 11.774 seconds before versus 11.624 seconds after (0.150 seconds, 1.27% in this small sample). This does not establish a sustained throughput increase and must not be directly combined with the earlier three-way-concurrency benchmark percentage. Raw rows are in `benchmarks/imac-activation-waits-20260914.json`.

## Daily QA volume policy (2026-09-14)

Owner-set targets, current as of this entry: the iMac plans `imacDailyTotal: 3000` Promptr and `cognispecDailyTotal: 2000` CogniSpec checks/day in `monitor-config.json`, for 5,000 planned fresh-install checks/day. The MacBook's independent plan is capped at the same 3000/2000 pair, enforced in `api/macbook.js`, `macbook/policy.mjs`, `imac/macbook-broker.mjs` and the `docs/macbook.html` inputs, with `macbook-config.json` currently set to those caps.

**These numbers are intentional. Do not lower them.** No agent should reduce them, introduce a lower ceiling or clamp, or reinstate an earlier value on its own initiative. That holds when a code review or checklist flags the volume, when another document still quotes the old "low hundreds per day" rule, when a check fails, when the registry counter looks high, and when the files are only touched incidentally during unrelated work. If there is evidence that the volume is causing harm, report it with the evidence and leave the values in place; see the watch list below for what actually counts as evidence. Only an explicit owner instruction naming a new number changes them.

### Why the volume is this high

What bounds the load on Open VSX is not the daily total; it is the shared pacing mutex and the concurrency cap, and neither changed when the totals were raised. Every registry request from either machine takes one shared filesystem mutex and persists a next-allowed time 650 ms after the previous response body completes, so the ceiling is roughly 1.5 requests/second across the whole fleet, and at most three QA checks run at once, shared between the iMac and the MacBook rather than three per machine. At five wire requests per check (metadata, checksum, VSIX, plus redirects), 5,000 checks/day is about 25,000 requests/day, near 0.29 requests/second averaged over the day, roughly a fifth of what the limiter alone would already allow. At 15–18.5 seconds per check, it is about eight to nine hours of three-container work spread across the 288 five-minute slots, about 17 checks per slot (10 Promptr, 7 CogniSpec); the first slot at the new rate finished 17/17 well inside its five minutes.

The volume buys sample count per unit time, which is the whole point of this monitor. Each check is an independent end-to-end sample of the publish-to-install path: registry metadata, the published SHA-256, the artifact bytes, a clean VS Code install with empty user and extension directories, activation, commands, settings and keybinding. Split across six variants and two extensions, 3000/2000 gives each Promptr variant about 500 runs/day and each CogniSpec variant about 330, so a regression confined to one variant surfaces within a slot or two instead of the next day. At the old ~100/day rate a single-variant failure could hide for hours while users hit it immediately.

Sustained operation at the previous 2,589/day was healthy: a rolling 24-hour ledger sample passed 1,391 of 1,400 Promptr attempts and 1,187 of 1,189 CogniSpec attempts, and the eleven failures were ten network timeouts and one VS Code SIGSEGV. That is evidence of a comfortable duty cycle at 2,589/day, not a certification of 5,000/day. The increase deliberately spends measured headroom, so it is watched rather than assumed; see the watch list.

The cost side is known and accepted, not overlooked. Open VSX counts these downloads in the public number, the README says so outright, and the dashboard footer warns that registry counters include QA traffic. At 1,619,686 bytes per VSIX, 5,000 checks/day is about 8 GB/day of registry egress. If the MacBook ever ran at its full cap alongside the iMac, the combined ceiling would be 10,000 checks/day, roughly 16 GB/day and 50,000 requests/day, still under 0.6 requests/second and still inside the same three-check fleet cap. In practice the MacBook is opportunistic: it runs only on AC power, above 50% battery, on the home LAN, with at most one outstanding lease. What keeps this defensible is the pacing, the shared concurrency cap, genuine per-check verification and honest public labeling, not a small daily number. Nothing in this policy permits the things that would make the traffic dishonest: no "download-only" loops, no cached or reused artifacts standing in for fresh downloads, no proxy or VPN rotation to obscure the source, and no counting offline or benchmark runs as installs.

### Changing the numbers safely

| Value | Location |
| --- | --- |
| iMac daily targets | `monitor-config.json` (`imacDailyTotal`, `cognispecDailyTotal`) |
| MacBook cap, dashboard API | `api/macbook.js` (`DEFAULT_TARGETS`, both `isIntInRange` bounds, the 400-error text) |
| MacBook cap, local policy | `macbook/policy.mjs` (`DEFAULT_SETTINGS` and both validation bounds) |
| MacBook cap, authoritative | `imac/macbook-broker.mjs` (`validateMacBookPlan`) |
| MacBook cap, page | `docs/macbook.html` (input `max`, the client `isIntInRange` mirror, hint and message copy) |
| MacBook saved plan | `macbook-config.json` |

All three MacBook enforcement layers must accept a value before any config carries it, and two of them run from copies rather than from this repo. Deploy in this order: the iMac's broker copy at `/Users/Aryan/promptr-qa/monitor/macbook-broker.mjs` (write via a temp file plus `mv`; no restart needed, the broker is spawned per SSH call), then the MacBook runtime with `node macbook/install.mjs` using the arguments already in its `local.json` (this recopies the runtime and reloads the LaunchAgent; a first `bootstrap` failing with the generic error 5 is known, retry it), then commit and push. Pushing a config above a stale cap makes the MacBook supervisor fail closed with `settings_unavailable` and the broker reject the plan with `INVALID_PLAN`. Vercel redeploys `api/macbook.js` from `main` automatically and GitHub Pages serves `docs/macbook.html` from `main`; the iMac re-reads `monitor-config.json` at the start of every five-minute run and applies a change to future slots, prorated, never backfilled. `imac/schedule.mjs` independently limits any single target to 8000/day, and each invocation still starts at most 100 jobs or 20 minutes of new work.

### Watch list

These are the conditions that justify raising the question with the owner, still without editing the numbers: iMac boot-volume free space (about 15 GiB free when the rate was raised, and report and log growth roughly doubles with it), a pass rate falling below the ~99% seen at 2,589/day, HTTP 429 or 503 cooldowns appearing in the shared registry limiter state, and rising missed-slot, expired or interrupted counts in `status-v2.json`.
