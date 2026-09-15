const vscode = require('vscode');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const {waitForSetting} = require('./wait-for-setting.cjs');

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const targetId = 'aryansudhir.cognispec';
const commandIds = ['cognispec.createStudy', 'cognispec.validateStudy', 'cognispec.openStudy'];
const notTested = ['Generated study execution/export correctness', 'AI requests', 'Real research data', 'Study output actions', 'macOS compatibility'];

exports.run = async () => {
  const out = process.env.RESULTS_DIR;
  const variant = process.env.TEST_VARIANT || 'unknown';
  const expectedVersion = process.env.EXPECTED_VSIX_VERSION;
  const checks = [];
  const record = (name, details) => checks.push({name, status: 'passed', details});
  const writeResults = (status, extra = {}) => fs.writeFileSync(path.join(out, 'checks.json'), JSON.stringify({variant, status, checks, notTested, ...extra}, null, 2));

  try {
    assert(out, 'RESULTS_DIR must be supplied by the parent harness');
    assert(expectedVersion?.trim(), 'EXPECTED_VSIX_VERSION must be supplied by the parent harness');
    assert.equal(process.arch, 'arm64', 'This suite must run in a native ARM64 Linux container');
    assert.equal(process.platform, 'linux', 'This suite is a native ARM64 Linux container check, not a macOS check');
    record('Native ARM64 Linux container', {arch: process.arch, platform: process.platform});

    const target = vscode.extensions.getExtension(targetId);
    assert(target, 'VS Code extension API cannot find freshly installed Cognispec');
    assert.equal(target.packageJSON.version, expectedVersion, 'Installed Cognispec version does not match EXPECTED_VSIX_VERSION');
    record('Fresh installed extension discovered', `${target.id}@${target.packageJSON.version}`);

    assert.equal(target.packageJSON.main, './dist/extension.js', 'Unexpected Cognispec extension entrypoint');
    assert(fs.existsSync(path.join(target.extensionPath, target.packageJSON.main)), 'Compiled extension entrypoint is missing from installed VSIX');
    record('Compiled extension entrypoint exists', target.packageJSON.main);

    let activationTimer;
    try {
      await Promise.race([
        target.activate(),
        new Promise((_, reject) => {
          activationTimer = setTimeout(() => reject(new Error('Activation timed out after 30 seconds')), 30000);
          activationTimer.unref();
        }),
      ]);
    } finally {
      clearTimeout(activationTimer);
    }
    assert(target.isActive, 'Cognispec did not become active');
    record('Extension activation completed within 30 seconds', true);

    const declared = target.packageJSON.contributes?.commands || [];
    for (const command of commandIds) assert(declared.some(contribution => contribution.command === command), `Missing command declaration: ${command}`);
    const registered = await vscode.commands.getCommands(true);
    for (const command of commandIds) assert(registered.includes(command), `Missing registered command: ${command}`);
    record('Cognispec commands declared and registered', commandIds);

    const configurationProperties = target.packageJSON.contributes?.configuration?.properties || {};
    const jsPsychProperty = configurationProperties['cognispec.jsPsychVersion'];
    assert(jsPsychProperty, 'Missing setting declaration: cognispec.jsPsychVersion');
    assert.equal(jsPsychProperty.type, 'string', 'cognispec.jsPsychVersion must be a string setting');
    assert.equal(jsPsychProperty.default, '8.2.1', 'Unexpected cognispec.jsPsychVersion schema default');
    const config = vscode.workspace.getConfiguration('cognispec');
    assert.equal(config.get('jsPsychVersion'), '8.2.1', 'Unexpected clean-install jsPsychVersion');
    assert.equal(config.inspect('jsPsychVersion')?.defaultValue, '8.2.1', 'Unexpected effective jsPsychVersion default');
    record('Clean jsPsychVersion setting is exposed through the VS Code settings API', '8.2.1');
    await config.update('jsPsychVersion', '8.2.3', vscode.ConfigurationTarget.Global);
    await waitForSetting(() => vscode.workspace.getConfiguration('cognispec').get('jsPsychVersion'), '8.2.3');
    assert.equal(vscode.workspace.getConfiguration('cognispec').get('jsPsychVersion'), '8.2.3', 'Test-only jsPsychVersion override did not persist');
    await config.update('jsPsychVersion', undefined, vscode.ConfigurationTarget.Global);
    await waitForSetting(() => vscode.workspace.getConfiguration('cognispec').get('jsPsychVersion'), '8.2.1');
    record('jsPsychVersion test-only global override round-trip', {updated: '8.2.3', reset: true});

    if (variant === 'manifest') {
      assert.deepEqual(target.packageJSON.activationEvents, commandIds.map(command => `onCommand:${command}`), 'Unexpected Cognispec activation events');
      assert.deepEqual(declared.map(contribution => contribution.command).sort(), [...commandIds].sort(), 'Unexpected Cognispec command declarations');
      record('VSIX manifest has the expected entrypoint, activation events, and commands', {main: target.packageJSON.main, activationEvents: target.packageJSON.activationEvents});
    }

    if (variant === 'clean-state') {
      assert.equal(vscode.extensions.all.filter(extension => extension.id.toLowerCase() === targetId).length, 1, 'Cognispec appears more than once in a clean profile');
      assert.equal(config.inspect('jsPsychVersion')?.globalValue, undefined, 'Clean profile has a jsPsychVersion override');
      record('Clean profile has one Cognispec extension and no setting override', true);
    }

    if (variant === 'settings-isolation') {
      await config.update('jsPsychVersion', '8.2.4', vscode.ConfigurationTarget.Global);
      await waitForSetting(() => vscode.workspace.getConfiguration('cognispec').get('jsPsychVersion'), '8.2.4');
      assert.equal(config.inspect('jsPsychVersion')?.globalValue, '8.2.4', 'Global override was not applied');
      await config.update('jsPsychVersion', undefined, vscode.ConfigurationTarget.Global);
      await waitForSetting(() => vscode.workspace.getConfiguration('cognispec').get('jsPsychVersion'), '8.2.1');
      assert.equal(config.inspect('jsPsychVersion')?.globalValue, undefined, 'Global override was not cleared');
      record('Settings isolation writes and clears a test-only global override', {updated: '8.2.4', reset: true});
    }

    if (variant === 'reinstall') record('CLI uninstall and reinstall lifecycle was verified before suite execution', true);
    if (variant === 'duplicate-install') record('CLI repeated-install idempotence was verified before suite execution', true);

    if (variant === 'ui-settings') {
      await vscode.commands.executeCommand('workbench.action.quickOpen', '>Cognispec');
      await delay(1500);
      cp.execFileSync('scrot', [path.join(out, 'cognispec-command-palette.png')], {timeout: 15000});
      await vscode.commands.executeCommand('workbench.action.closeQuickOpen');
      record('UI-only command palette screenshot captured without invoking Cognispec', 'cognispec-command-palette.png');
    }

    writeResults('passed');
    console.log(`COGNISPEC_EXTENDED_SMOKE_TEST_PASSED ${JSON.stringify({variant, checks})}`);
  } catch (error) {
    try { if (out) writeResults('failed', {error: String(error.stack || error)}); } catch {}
    try { if (out) cp.execFileSync('scrot', [path.join(out, 'failure.png')], {timeout: 15000}); } catch {}
    throw error;
  }
};
