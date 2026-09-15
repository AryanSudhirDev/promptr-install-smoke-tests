// Runs INSIDE a fresh container on the iMac (Colima). Downloads the published Promptr release from
// Open VSX itself, verifies the registry SHA-256, installs it into a clean VS Code and verifies it.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const {createRegistryFetch} = require('./registry-fetch.cjs');
const {verifyInstallation} = require('./install-lifecycle.cjs');
const {resolveCliArgsFromVSCodeExecutablePath, runTests} = require('@vscode/test-electron');

function runChecked(command, args, options = {}) {
  const result = cp.spawnSync(command, args, {encoding: 'utf8', timeout: 180000, ...options});
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${command} failed: ${result.stderr || ''}${result.stdout || ''}`);
  return (result.stdout || '').trim();
}

(async () => {
  const root = __dirname;
  const targetId = process.env.TARGET_EXTENSION || 'aryansudhir.promptr';
  const targetName = targetId.split('.')[1];
  assert(['aryansudhir.promptr','aryansudhir.cognispec'].includes(targetId), 'Unsupported QA target');
  const resultDir = path.join(root, 'results');
  const stateDir = path.join(root, 'state');
  const userDir = path.join(stateDir, 'user');
  const extensionsDir = path.join(stateDir, 'extensions');
  const vsix = path.join(root, 'input', targetName + '.vsix');
  const variant = process.env.TEST_VARIANT || 'unknown';
  const executable = process.env.VSCODE_EXECUTABLE || '/usr/share/code/code';
  fs.mkdirSync(resultDir, {recursive: true});
  fs.mkdirSync(path.join(root, 'input'), {recursive: true});
  const started = performance.now();
  let stageStarted = started;
  const timings = {schemaVersion: 1, runId: process.env.TEST_RUN, targetId, variant, status: 'failed', stagesMs: {}, cli: []};
  const finishStage = name => { const now = performance.now(); timings.stagesMs[name] = Math.round(now - stageStarted); stageStarted = now; };
  try {
  // Fresh registry retrieval, either direct or from this job's single-use host relay.
  assert(!fs.existsSync(vsix), 'VSIX must not be present before this fresh download');
  const registryUrl = 'https://open-vsx.org/api/aryansudhir/' + targetName;
  const registryFetch = createRegistryFetch({stateDir: process.env.REGISTRY_LIMIT_DIR, reportDir: resultDir, runId: process.env.TEST_RUN});
  const fetchOk = async (url) => { const r = await registryFetch(url); assert(r.ok, url + ' -> HTTP ' + r.status); return r; };
  const registry = await (await fetchOk(registryUrl)).json();
  const expectedVersion = registry.version;
  const expectedHash = (await (await fetchOk(registry.files.sha256)).text()).trim();
  assert(/^[0-9a-f]{64}$/.test(expectedHash), 'Registry did not return a valid sha256');
  const downloadStart = new Date().toISOString();
  fs.writeFileSync(vsix, Buffer.from(await (await fetchOk(registry.files.download)).arrayBuffer()));
  const downloadEnd = new Date().toISOString();
  finishStage('registry');

  // A fresh sandbox has no prior VS Code state. Anything here means the environment is not clean.
  assert(!fs.existsSync(stateDir), `Expected a clean sandbox, but found ${stateDir}`);
  for (const home of ['/root/.config/Code', '/root/.vscode']) assert(!fs.existsSync(home), `Expected no prior VS Code state at ${home}`);
  assert(fs.existsSync(vsix), 'Downloaded VSIX is missing');
  assert(fs.existsSync(executable), `VS Code executable missing at ${executable}`);

  const artifact = {
    targetId,
    source: registry.files.download,
    downloadStart: registryFetch.provenance?.downloadStart ?? downloadStart,
    downloadEnd: registryFetch.provenance?.downloadEnd ?? downloadEnd,
    downloadEnvironment: registryFetch.provenance?.downloadEnvironment ?? 'imac-colima-container',
    registryTransport: registryFetch.provenance?.relayKind ?? 'direct',
    environment: 'imac-colima-container',
    container: process.env.HOSTNAME,
    plannedDate: process.env.DAILY_PLAN_DATE,
    variant,
    bytes: fs.statSync(vsix).size,
    sha256: crypto.createHash('sha256').update(fs.readFileSync(vsix)).digest('hex'),
  };
  assert(artifact.bytes > 0, 'Downloaded VSIX is empty');
  assert.equal(artifact.sha256, expectedHash, 'Downloaded VSIX hash does not match the published Open VSX hash');
  runChecked('unzip', ['-t', vsix]);
  const manifest = JSON.parse(runChecked('unzip', ['-p', vsix, 'extension/package.json']));
  assert.equal(manifest.publisher + '.' + manifest.name, targetId);
  assert.equal(manifest.version, expectedVersion);
  assert.equal(manifest.main, './dist/extension.js');
  assert(manifest.engines?.vscode, 'VSIX is missing a VS Code engine requirement');
  assert(manifest.activationEvents?.includes(targetName === 'promptr' ? 'onStartupFinished' : 'onCommand:cognispec.createStudy'), 'Expected activation trigger missing');
  fs.writeFileSync(path.join(resultDir, 'download.json'), JSON.stringify({...artifact, manifest}, null, 2));
  finishStage('artifactVerification');

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
  finishStage('profileSetup');
  const command = args => {
    const begin = performance.now();
    let ok = false;
    try { const output = runChecked(cli, [...cliArgs, ...common, ...args]); ok = true; return output; }
    finally { timings.cli.push({operation: args[0], ms: Math.round(performance.now() - begin), ok}); }
  };
  const verified = verifyInstallation({command, targetId, expectedVersion, variant, vsix});
  const installation = {targetId, variant, expectedVersion, environment: 'imac-colima-container', container: artifact.container, freshStateBeforeInstall: true, artifactSha256: artifact.sha256, ...verified};
  fs.writeFileSync(path.join(resultDir, 'installation.json'), JSON.stringify(installation, null, 2));
  console.log(JSON.stringify({artifact, installation}, null, 2));
  finishStage('cliLifecycle');

  try {
    await runTests({
      vscodeExecutablePath: executable,
      extensionDevelopmentPath: path.join(root, 'helper'),
      extensionTestsPath: path.join(root, 'extended-suite.cjs'),
      extensionTestsEnv: {RESULTS_DIR: resultDir, TEST_VARIANT: variant, TEST_RUN: process.env.TEST_RUN || variant, EXPECTED_VSIX_VERSION: expectedVersion},
      launchArgs: [...common, '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust', '--disable-gpu'],
    });
    timings.status = 'passed';
  } finally {
    finishStage('activationSuite');
    const logs = path.join(userDir, 'logs');
    try { if (fs.existsSync(logs)) fs.cpSync(logs, path.join(resultDir, 'vscode-logs'), {recursive: true, force: true, errorOnExist: false}); } catch (e) { console.warn('log copy skipped:', e.code || e.message); }
    finishStage('logCollection');
  }
  } finally {
    timings.totalMs = Math.round(performance.now() - started);
    timings.unattributedMs = Math.round(performance.now() - stageStarted);
    fs.writeFileSync(path.join(resultDir, 'timings.json'), JSON.stringify(timings, null, 2));
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
