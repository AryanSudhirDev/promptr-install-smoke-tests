# Promptr clean-install smoke tests

Tests the published Open VSX VSIX on three fresh standard GitHub-hosted Ubuntu VMs. One job downloads the VSIX once; all three test jobs reuse that exact artifact. Each test job downloads desktop VS Code, starts with empty user/extension directories, installs the VSIX, checks activation, command registration, settings and keybinding contributions, and captures the UI.

No Promptr access token, account creation, paid AI requests, or production publishing. This does not validate backend prompt refinement, Cursor-specific integration, Windows, or macOS. GitHub tears down hosted VMs after each job; local test state is additionally deleted by the workflow. Results and screenshots are retained as short-lived workflow artifacts.
