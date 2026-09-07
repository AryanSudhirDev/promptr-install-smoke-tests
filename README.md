# Promptr clean-install smoke tests

Tests the published Open VSX VSIX on three fresh standard GitHub-hosted Ubuntu VMs. One job downloads the VSIX once; all three test jobs reuse that exact artifact. Each test job downloads desktop VS Code, starts with empty user/extension directories, installs the VSIX, checks activation, command registration, settings and keybinding contributions, and captures the UI.

No Promptr access token, account creation, paid AI requests, or production publishing. This does not validate backend prompt refinement, Cursor-specific integration, Windows, or macOS. GitHub tears down hosted VMs after each job; local test state is additionally deleted by the workflow. Results and screenshots are retained as short-lived workflow artifacts.

## Daily health QA

`Daily Promptr health QA (45-65 fresh downloads)` runs from an hourly GitHub Actions schedule. A deterministic date seed selects 8-16 UTC hours that change each day and distributes 45-65 tests across them. Each selected job gets a separate standard `ubuntu-24.04` hosted VM, resolves the current Open VSX version, downloads that VSIX directly with cache bypass, verifies the registry SHA-256, installs desktop VS Code, runs one of six clean-install variants, uploads short-lived evidence, and wipes the VM workspace. The hourly planner does not download the extension; only test jobs do.

The schedule is a reliability monitor, not a marketplace metric. It uses no Promptr access token and makes no paid AI requests.
