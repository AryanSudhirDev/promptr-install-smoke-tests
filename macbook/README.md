# MacBook opportunistic QA worker

A local macOS LaunchAgent supervises one native ARM64 Docker worker. It does not use AI, coordinate clicking, paid inference, browser credentials, or a separate public-download quota.

## Default policy

- Enabled, but eligible only while on AC power, battery **strictly above 50%**, and on the configured home LAN with a successful direct, pinned-key SSH check to the home iMac.
- Dashboard configuration refresh every 10 minutes, editable from `docs/macbook.html` via `/api/macbook`.
- A running worker rechecks eligibility every 15 seconds and before each job. Unknown power, inaccessible settings, an unverified required home connection, or less than 20 GiB free disk fails closed.
- One delegated check at a time. Each container is capped at 2 CPUs, 2 GiB RAM, 512 processes and 512 MiB shared memory; container swap is disabled. The host can still compress/swap memory. This is not a validated throughput increase.
- AC idle-sleep prevention applies only while enabled and the home requirement is satisfied. Display sleep, manual sleep, lid closure, logout and shutdown are not overridden. A login agent starts after login, not before FileVault unlock.
- Launchd restarts a crashed supervisor. Reused PIDs are checked against the expected script, and an existing live worker is never duplicated.

## Shared work and fresh artifact transfer

The MacBook claims only already-planned jobs from the existing iMac ledgers. Promptr and CogniSpec totals stay unchanged. No production extension repository is modified.

The coordinator performs one **new** retrieval of registry metadata, the SHA-256 and VSIX for every claimed job, using the same 650 ms filesystem limiter and exclusive monitor lock. Redirects are independently paced. The newly retrieved bytes are transferred once over pinned SSH to a brand-new MacBook container. They are never reused for another check. This is artifact transport, not an HTTP proxy, IP rotation or a cache. The iMac does not retain the VSIX.

The native image contains VS Code, Node and the harness, **not a product VSIX**. The per-job transfer file is deleted after use. The container runs with networking disabled and performs the same checksum, manifest, install, lifecycle, activation, command, settings and UI assertions as the iMac suites. Reports explicitly identify `macbook-docker-arm64` and `imac-pinned-ssh-fresh-download-relay`.

There is at most one outstanding MacBook lease and at most three shared QA checks. Expired leases remain fenced as `remote_cleanup_pending` until the MacBook confirms its owned containers are removed. A clock timeout alone never returns capacity. Recovery cleans only labeled MacBook QA containers and marks abandoned jobs failed, never requeues or recounts their downloads. A successful completion needs matching target/version/hash/variant, a clean-state installation report, all passing assertions, the target success marker, and confirmed container cleanup.

## Dashboard security and privacy

`api/macbook.js` uses the existing dashboard key for writes; GitHub credentials stay on Vercel. The public config contains only enabled, threshold, interval and policy booleans. Real battery level, home presence, SSH configuration, lease tokens and device status are never published.

Private status: `http://127.0.0.1:47831/`, reachable only from this Mac. It is linked manually from the dashboard and is not fetched by the public page. The local service rejects foreign origins, unexpected Host headers and all writes. Runtime files live in a user-private `~/Library/Application Support/Promptr QA MacBook` directory.

## Installation and operation

`install.mjs` copies the runtime and prepares `~/Library/LaunchAgents/com.promptr.qa.macbook.plist`. Private home subnet, pinned SSH alias, broker path and remote Node path are passed as local setup arguments; do not commit the resulting `local.json`.

The setup command accepts `--load false` to prepare/validate files when running from a sandbox that cannot invoke launchd. In that case, load the prepared agent once in the user's normal Terminal:

```sh
launchctl bootstrap gui/$(id -u) "$HOME/Library/LaunchAgents/com.promptr.qa.macbook.plist"
```

On first eligible startup it opens the installed Docker Desktop and builds the native image. If Docker has unfinished first-run setup, its local status identifies that blocker; the service cannot accept permissions or licensing prompts for the user.

Pause through the dashboard, or unload locally:

```sh
launchctl bootout gui/$(id -u)/com.promptr.qa.macbook
```

No administrator password is needed for the user LaunchAgent command. Do not use `sudo`. User-created Docker containers, images and other launch agents are not removed.

## Verification scope

Unit/regression tests cover power policy, strict configuration, subprocess cancellation and limits, PID locking, relay hash/identity/one-use checks, API authorization, report validation, concurrency fencing, pruning and recovery. Native image build and full MacBook end-to-end execution must be verified on an eligible Mac with Docker running; passing unit tests alone does not establish that hardware's throughput or complete setup.
