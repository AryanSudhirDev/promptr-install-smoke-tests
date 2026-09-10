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
- Keep total registry traffic in the low hundreds per day at most; Open VSX counts CI fetches in
  the public number, and the QA repo README says so.
- Do not route traffic through proxies/VPN rotation to obscure the source.
- Never commit `github_token`, `.env`, or `imac_ed25519`.
- If GitHub ever emails about Actions usage, reply promptly with the QA repo README.

## iMac scheduler v2 (2026-09-09)

Source: `imac/`. Deployed under `~/promptr-qa/monitor` on the iMac.

- Dashboard accepts 1–1000 checks/day. The host reads the existing repo setting every invocation.
- Five-minute slots at :02/:07/.../:57, 288 per UTC day. Exact total uses cumulative integer allocation, so 780 means 2–3 checks per slot, not six per half-hour.
- Maximum three concurrent containers. Launchd prevents overlapping service runs; a PID lock also protects manual invocations.
- Durable per-job queue (`scheduler-v2.json`): max 100 jobs or 20 minutes of new starts per invocation; untouched jobs remain pending. Started jobs are not retried automatically after interruption.
- Six-hour catch-up window. Expired jobs and missed scheduling slots are explicitly counted, not claimed as passes. Seven-day scheduler-state retention; per-job reports remain on disk.
- Setting changes apply to future slots after the next configuration read. A partial day is prorated, not backfilled to the new daily total.
- Migration starts at the current slot; the previous capped runner's skipped jobs are not replayed.
- Installation success requires the extension-test success marker, not just a successful container exit.
- Local `status-v2.json` and `history.jsonl` expose passed/failed/pending/expired/interrupted counts. Hosted dashboard still lacks the iMac heartbeat and must not infer health from a setting.
- Pre-migration runner and plist backed up at `~/promptr-qa/monitor/backups/pre-v2/`.
- Regression: `npm run test:dashboard` includes every allowed total from 1 through 1000, changes, midnight rollover, batch caps, and expiration, without running containers or downloading the extension.
