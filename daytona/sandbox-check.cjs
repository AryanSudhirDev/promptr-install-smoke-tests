// Runs INSIDE a fresh Daytona sandbox. Mirrors the GitHub Actions harness (extended-run-test.cjs)
// but uses the VS Code build baked into the sandbox image and a VSIX that the orchestrator
// fetched from Open VSX and uploaded to this sandbox (Tier 1/2 sandboxes cannot reach the registry).
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const {resolveCliArgsFromVSCodeExecutablePath, runTests} = require('@vscode/test-electron');

function runChecked(command, args, options = {}) {
  const result = cp.spawnSync(command, args, {encoding: 'utf8', timeout: 180000, ...options});
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${command} failed: ${result.stderr || ''}${result.stdout || ''}`);
  return (result.stdout || '').trim();
}

(async () => {
  const root = __dirname;
  const resultDir = path.join(root, 'results');
  const stateDir = path.join(root, 'state');
  const userDir = path.join(stateDir, 'user');
  const extensionsDir = path.join(stateDir, 'extensions');
  const vsix = path.join(root, 'input', 'promptr.vsix');
  const variant = process.env.TEST_VARIANT || 'unknown';
  const expectedVersion = process.env.EXPECTED_VSIX_VERSION;
  const expectedHash = process.env.EXPECTED_VSIX_SHA256;
  const executable = process.env.VSCODE_EXECUTABLE || '/usr/share/code/code';
  assert(expectedVersion && expectedHash, 'Orchestrator must pass EXPECTED_VSIX_VERSION and EXPECTED_VSIX_SHA256');
  fs.mkdirSync(resultDir, {recursive: true});

  // A fresh sandbox has no prior VS Code state. Anything here means the environment is not clean.
  assert(!fs.existsSync(stateDir), `Expected a clean sandbox, but found ${stateDir}`);
  for (const home of ['/root/.config/Code', '/root/.vscode']) assert(!fs.existsSync(home), `Expected no prior VS Code state at ${home}`);
  assert(fs.existsSync(vsix), 'Uploaded VSIX is missing');
  assert(fs.existsSync(executable), `VS Code executable missing at ${executable}`);

  const artifact = {
    source: process.env.PROMPTR_VSIX_URL,
    fetchedByOrchestratorAt: process.env.VSIX_FETCHED_AT,
    environment: 'daytona-sandbox',
    sandboxId: process.env.DAYTONA_SANDBOX_ID,
    batch: process.env.BATCH_ID,
    variant,
    bytes: fs.statSync(vsix).size,
    sha256: crypto.createHash('sha256').update(fs.readFileSync(vsix)).digest('hex'),
  };
  assert(artifact.bytes > 0, 'Uploaded VSIX is empty');
  assert.equal(artifact.sha256, expectedHash, 'VSIX hash inside the sandbox does not match the published Open VSX hash');
  runChecked('unzip', ['-t', vsix]);
  const manifest = JSON.parse(runChecked('unzip', ['-p', vsix, 'extension/package.json']));
  assert.equal(manifest.publisher + '.' + manifest.name, 'aryansudhir.promptr');
  assert.equal(manifest.version, expectedVersion);
  assert.equal(manifest.main, './dist/extension.js');
  assert(manifest.engines?.vscode, 'VSIX is missing a VS Code engine requirement');
  assert.equal(manifest.activationEvents?.[0], 'onStartupFinished');
  fs.writeFileSync(path.join(resultDir, 'download.json'), JSON.stringify({...artifact, manifest}, null, 2));

  fs.mkdirSync(path.join(userDir, 'User'), {recursive: true});
  fs.mkdirSync(extensionsDir, {recursive: true});
  fs.writeFileSync(path.join(userDir, 'User', 'settings.json'), JSON.stringify({
    'telemetry.telemetryLevel': 'off',
    'update.mode': 'none',
    'extensions.autoUpdate': false,
    'extensions.autoCheckUpdates': false,
    'workbench.startupEditor': 'none',
    'workbench.enableExperiments': false,
    'security.workspace.trust.enabled': false,
  }));
  const [cli, ...cliArgs] = resolveCliArgsFromVSCodeExecutablePath(executable);
  const common = ['--user-data-dir', userDir, '--extensions-dir', extensionsDir, '--disable-telemetry', '--no-sandbox'];
  const command = (args) => runChecked(cli, [...cliArgs, ...common, ...args]);
  const before = command(['--list-extensions']);
  assert.equal(before, '', `Fresh extension directory was not empty: ${before}`);
  const installOutput = command(['--install-extension', vsix]);
  const installedLine = `aryansudhir.promptr@${expectedVersion}`.toLowerCase();
  const listInstalled = () => command(['--list-extensions', '--show-versions']).toLowerCase().split(/\r?\n/);
  assert(listInstalled().includes(installedLine), `Published extension was not installed: ${listInstalled().join(',')}`);
  const lifecycle = [];
  if (variant === 'reinstall') {
    command(['--uninstall-extension', 'aryansudhir.promptr']);
    assert(!listInstalled().includes(installedLine), 'Extension remained installed after uninstall');
    command(['--install-extension', vsix]);
    assert(listInstalled().includes(installedLine), 'Extension did not return after reinstall');
    lifecycle.push({uninstalled: true, reinstalled: true});
  }
  if (variant === 'duplicate-install') {
    command(['--install-extension', vsix]);
    const matches = listInstalled().filter(line => line === installedLine);
    assert.equal(matches.length, 1, `Repeated install created an unexpected extension listing`);
    lifecycle.push({secondInstall: true, uniqueListings: matches.length});
  }
  const vscodeVersion = command(['--version']);
  const installation = {variant, expectedVersion, environment: 'daytona-sandbox', sandboxId: artifact.sandboxId, freshStateBeforeInstall: true, artifactSha256: artifact.sha256, installed: listInstalled(), vscodeVersion, installOutput, lifecycle};
  fs.writeFileSync(path.join(resultDir, 'installation.json'), JSON.stringify(installation, null, 2));
  console.log(JSON.stringify({artifact, installation}, null, 2));

  try {
    await runTests({
      vscodeExecutablePath: executable,
      extensionDevelopmentPath: path.join(root, 'helper'),
      extensionTestsPath: path.join(root, 'extended-suite.cjs'),
      extensionTestsEnv: {RESULTS_DIR: resultDir, TEST_VARIANT: variant, TEST_RUN: process.env.TEST_RUN || variant, EXPECTED_VSIX_VERSION: expectedVersion},
      launchArgs: [...common, '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust', '--disable-gpu'],
    });
  } finally {
    const logs = path.join(userDir, 'logs');
    if (fs.existsSync(logs)) fs.cpSync(logs, path.join(resultDir, 'vscode-logs'), {recursive: true});
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
