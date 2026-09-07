const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const {downloadAndUnzipVSCode, resolveCliArgsFromVSCodeExecutablePath, runTests} = require('@vscode/test-electron');

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
  const expectedHash = process.env.EXPECTED_VSIX_SHA256;
  fs.mkdirSync(resultDir, {recursive: true});

  // The runner starts empty. Any pre-existing state means this is not a clean test.
  for (const cleanPath of [stateDir, path.join(root, '.vscode-test')]) {
    assert(!fs.existsSync(cleanPath), `Expected clean runner, but found ${cleanPath}`);
  }
  assert(fs.existsSync(path.join(root, 'input')), 'Workflow did not create the input directory');
  assert(fs.existsSync(vsix), 'Fresh VSIX download is missing');

  const download = {
    url: 'https://open-vsx.org/api/aryansudhir/promptr/1.5.6/file/aryansudhir.promptr-1.5.6.vsix',
    downloadedAt: new Date().toISOString(),
    runnerName: process.env.RUNNER_NAME,
    runnerOs: process.env.RUNNER_OS,
    runnerArch: process.env.RUNNER_ARCH,
    workflowRun: process.env.GITHUB_RUN_ID,
    job: process.env.GITHUB_JOB,
    variant,
    bytes: fs.statSync(vsix).size,
    sha256: crypto.createHash('sha256').update(fs.readFileSync(vsix)).digest('hex'),
  };
  assert(download.bytes > 0, 'Fresh VSIX download is empty');
  assert.equal(download.sha256, expectedHash, 'Downloaded VSIX hash does not match published Promptr 1.5.6');
  runChecked('unzip', ['-t', vsix]);
  const manifest = JSON.parse(runChecked('unzip', ['-p', vsix, 'extension/package.json']));
  assert.equal(manifest.publisher + '.' + manifest.name, 'aryansudhir.promptr');
  assert.equal(manifest.version, '1.5.6');
  assert.equal(manifest.main, './dist/extension.js');
  assert.equal(manifest.engines?.vscode, '^1.86.0');
  assert.equal(manifest.activationEvents?.[0], 'onStartupFinished');
  assert(fs.existsSync(path.join(root, 'input', 'promptr.vsix')), 'VSIX vanished before installation');
  fs.writeFileSync(path.join(resultDir, 'download.json'), JSON.stringify({...download, manifest}, null, 2));

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
  const executable = await downloadAndUnzipVSCode('stable');
  const [cli, ...cliArgs] = resolveCliArgsFromVSCodeExecutablePath(executable);
  const command = (args) => runChecked(cli, [...cliArgs, '--user-data-dir', userDir, '--extensions-dir', extensionsDir, '--disable-telemetry', ...args]);
  const before = command(['--list-extensions']);
  assert.equal(before, '', `Fresh extension directory was not empty: ${before}`);
  const installOutput = command(['--install-extension', vsix]);
  const installed = command(['--list-extensions', '--show-versions']);
  assert(installed.toLowerCase().split(/\r?\n/).includes('aryansudhir.promptr@1.5.6'), `Published extension was not installed: ${installed}`);
  const vscodeVersion = command(['--version']);
  const installation = {variant, runnerName: process.env.RUNNER_NAME, freshStateBeforeInstall: true, freshVSIXDownload: true, downloadSha256: download.sha256, installed, vscodeVersion, installOutput};
  fs.writeFileSync(path.join(resultDir, 'installation.json'), JSON.stringify(installation, null, 2));
  console.log(JSON.stringify({download, installation}, null, 2));

  try {
    await runTests({
      vscodeExecutablePath: executable,
      extensionDevelopmentPath: path.join(root, 'helper'),
      extensionTestsPath: path.join(root, 'extended-suite.cjs'),
      extensionTestsEnv: {RESULTS_DIR: resultDir, TEST_VARIANT: variant, TEST_RUN: process.env.TEST_RUN || variant},
      launchArgs: ['--user-data-dir', userDir, '--extensions-dir', extensionsDir, '--disable-telemetry', '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust', '--disable-gpu'],
    });
  } finally {
    const logs = path.join(userDir, 'logs');
    if (fs.existsSync(logs)) fs.cpSync(logs, path.join(resultDir, 'vscode-logs'), {recursive: true});
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
