# Promptr clean-install QA

Continuous install testing for [Promptr](https://github.com/AryanSudhirDev/promptr), a VS Code extension published on Open VSX as [`aryansudhir.promptr`](https://open-vsx.org/extension/aryansudhir/promptr). Both repositories are maintained by the same author.

## What this repository does

Every run installs the currently published Promptr release on a brand-new GitHub-hosted Ubuntu VM, exactly the way a new user would, and checks that it works:

- fetches the published VSIX from Open VSX and verifies its SHA-256 against the registry
- installs desktop VS Code with empty user and extension directories
- installs the VSIX and confirms the extension activates and registers its commands, settings, and keybinding
- runs one of six clean-install variants: `manifest`, `clean-state`, `settings-isolation`, `ui-settings`, `reinstall`, `duplicate-install`
- captures a screenshot and a JSON report as short-lived evidence (2-day retention)
- wipes the workspace; GitHub decommissions the VM after the job

## Why it exists

Promptr has real users who install it from Open VSX. A publishing regression, a broken VSIX, a VS Code update, or a registry problem would only be discovered by users unless something checks the published artifact continuously. This repository is that check. It is separate from the main Promptr repository so that the production codebase and its CI stay untouched.

## Schedule and volume

`Promptr install reliability monitor` runs on a GitHub Actions schedule (every 2 hours, best-effort). A date-seeded plan chooses 8-16 UTC hours per day and spreads 70-90 tests across them, so timing and volume vary day to day but remain reproducible. Each run looks at previous runs to find which planned slots are still due, runs those, and exits. No runner ever idles between slots.

Per run: one Open VSX API call to resolve the published version and hash. Per test: one VSIX download. If Open VSX is unreachable the run exits without scheduling tests.

## Daytona sandbox checks

`Promptr clean-install checks (Daytona sandboxes)` runs the same clean-install check in disposable [Daytona](https://www.daytona.io) sandboxes, every 3 hours in batches (size set by the repository variable `DAYTONA_CHECKS_PER_RUN`, default 12). The GitHub job only orchestrates: it resolves the published release on Open VSX once per batch, fetches the VSIX once and verifies its SHA-256, then uploads that artifact into each fresh sandbox. The sandbox image (`daytona/build-snapshot.mjs`) contains desktop VS Code from Microsoft's apt repository, Xvfb and the test harness dependency, and no Promptr artifact. Sandboxes never contact Open VSX; each one is deleted after its report is collected. A check takes roughly 10 seconds and about $0.0005 of sandbox compute.

## What this does not do

- no Promptr access token, no account creation, no paid AI requests, no production publishing
- no validation of backend prompt refinement, Cursor-specific integration, Windows, or macOS
- not a marketplace metric: CI downloads are counted by Open VSX like any other, so Promptr's public download count includes this testing

## Workflows

- `.github/workflows/daily-health-qa.yml` - `Promptr install reliability monitor`, the scheduled check described above
- `.github/workflows/four-fresh-downloads.yml` - `Promptr clean-install variants (manual)`, a one-off four-variant run
- `.github/workflows/daytona-install-checks.yml` - `Promptr clean-install checks (Daytona sandboxes)`, scheduled sandbox batches
- `.github/workflows/daytona-snapshot.yml` - manual rebuild of the Daytona sandbox image
