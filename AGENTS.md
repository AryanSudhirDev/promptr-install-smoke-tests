# Agent notes

Clean-install QA for the published Promptr and CogniSpec extensions. Production extension code lives
elsewhere (`AryanSudhirDev/promptr`) and is never modified from here. Full operating guide:
`OPERATIONS.md`.

## Daily volume is owner-set: do not change it in either direction

The fleet plans **10000 checks/day**: **4000 Promptr + 6000 CogniSpec** overall. The iMac is
2000 Promptr + 3000 CogniSpec (`monitor-config.json`) and the MacBook is 2000 + 3000
(`macbook-config.json`, `DEFAULT_SETTINGS` in `macbook/policy.mjs`, and the eight-hour figures
`OVERNIGHT_PROMPTR_CHECKS`/`OVERNIGHT_COGNISPEC_CHECKS` in `macbook/overnight.mjs`, which are sized
so a high-concurrency window lands on the same daily plan rather than raising it). Neither
dashboard caps these: the upper bounds (`MAX_TOTAL`, `MAX_IMAC`, `MAX_TARGET`, all 50,000/day) are
typo guards for the job ledger, not the approved volume.

Owner instruction 2026-09-17 swapped the shares so CogniSpec is the larger side (Promptr 4000 /
CogniSpec 6000) with the fleet total unchanged at 10000. That is not a restore of the retired
22,500/day plan. Owner instruction 2026-09-17 earlier raised 8000 → 10000 after the MacBook was
home on eleven lanes with 0% 503s under load; 2026-09-16 set 6000 after Open VSX 503s. Only an
explicit owner instruction naming a new number changes them, in either direction. If throughput
looks limited, read the escalation section in `OPERATIONS.md` before touching a number.

What actually bounds the registry load, the full list of locations, the order deployments must
follow, and the conditions worth escalating: see "Daily QA volume policy" at the end of
`OPERATIONS.md`. Read it before changing anything about rates, pacing or concurrency.

## Do not send `Cache-Control: no-cache` to Open VSX

`imac/registry-fetch.cjs` deliberately sends no cache-control header. That header forced every
request past Fastly to the origin, which answered 503 for 5 of 8 paired probes against 1 of 8
without it (2026-09-16); since one 503 arms a fleet-wide cooldown, the header alone could
stall the fleet. Re-adding it in the name of "fresh downloads" is wrong: a check is fresh because
the bytes cross the network and are verified against the published SHA-256, not because the
registry's own CDN was bypassed. `tests/imac-registry.test.mjs` guards this. Consecutive 429/503s
stretch that cooldown (up to five minutes) and drop to one probe stream until the registry
answers; do not remove that backoff or restore two-stream pile-on during a throttle.

## Other ground rules

- Every check does real verification: download plus SHA-256, clean install, activation, assertions.
  Never reduce a check to "download only", reuse a cached artifact as a fresh download, or count
  offline and benchmark runs as installs.
- Do not touch the shared 650 ms per-stream registry gap or the three-check concurrency cap. The
  fleet uses two Open VSX streams capped at 2.5 req/s by owner instruction. Those, not the daily
  total, are the safeguards.
- The MacBook's eleven-lane high-concurrency mode is all-day by owner instruction (2026-09-15), and
  its nightly window ends at 7:50 AM local. It needs the home network plus power that
  `powerAllowsWork` accepts: on AC always, on battery only at or above `minBatteryPercent` (40). The
  battery floor intentionally does not apply while plugged in. Do not put this back on a night-only
  schedule, shorten `SUSTAINED_HOURS`, or set `requireAC` back on.
- Away from home the MacBook keeps running at `DAY_WORKERS: 3`; it does not stop. `requireHome` and
  `requireAC` are both `false` on purpose, `eligibility` probes `atHome()` regardless so the lane
  count can follow it, and `maintainSustainedWindow` drops the window when home or power goes away.
  Do not "fix" this by turning `requireHome` back on or by skipping the probe when it is off.
- Do not route traffic through proxies or VPN rotation to obscure its source.
- Passed-job report folders are deleted after the ledger write; failed and in-flight evidence stays until free space drops below about 6 GiB, when leftover reports and archives are pruned. Downloads, hashes, installs and assertions still happen. The 5 GiB pause remains the last stop, not the cleanup trigger.
- Never commit `github_token`, `.env`, or `imac_ed25519`.
- `imac/` and `macbook/` run from deployed copies, not from this checkout; editing a file here
  changes nothing until it is deployed (`OPERATIONS.md` has the commands).
