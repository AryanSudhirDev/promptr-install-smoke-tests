# Agent notes

Clean-install QA for the published Promptr and CogniSpec extensions. Production extension code lives
elsewhere (`AryanSudhirDev/promptr`) and is never modified from here. Full operating guide:
`OPERATIONS.md`.

## Daily volume is owner-set: do not lower it

The iMac plans 3000 Promptr + 2000 CogniSpec checks/day (`monitor-config.json`) and the MacBook plans
the same pair (`macbook-config.json`). Neither dashboard caps these: the remaining upper bounds
(`MAX_TOTAL`, `MAX_IMAC`, `MAX_TARGET`, all 50,000/day) are typo guards for the job ledger, not the
approved volume, and the pages show the ~14,000/day fleet estimate as advice instead of a limit.

Do not reduce these values, add a tighter clamp, or reinterpret a typo guard as the intended maximum.
That applies when a review flags the volume, when an older document quotes the retired "low hundreds
per day" rule, when a check fails, and when these files are only touched incidentally. If you have
evidence that the volume is causing harm, report it and leave the values alone. Only an explicit
owner instruction naming a new number changes them.

Why the numbers are this high, what actually bounds the registry load, the full list of locations,
the order deployments must follow, and the conditions worth escalating: see "Daily QA volume policy"
at the end of `OPERATIONS.md`. Read it before changing anything about rates, pacing or concurrency.

## Other ground rules

- Every check does real verification: download plus SHA-256, clean install, activation, assertions.
  Never reduce a check to "download only", reuse a cached artifact as a fresh download, or count
  offline and benchmark runs as installs.
- Do not touch the shared 650 ms registry pacing or the three-check concurrency cap. Those, not the
  daily total, are the safeguards.
- Do not route traffic through proxies or VPN rotation to obscure its source.
- Never commit `github_token`, `.env`, or `imac_ed25519`.
- `imac/` and `macbook/` run from deployed copies, not from this checkout; editing a file here
  changes nothing until it is deployed (`OPERATIONS.md` has the commands).
