const vscode = require('vscode');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const notTested = [
  'Generated study execution/export correctness',
  'Real research data',
  'Cursor/nativeOS',
];

exports.run = async () => {
  const out = process.env.RESULTS_DIR;
  const variant = process.env.TEST_VARIANT || 'unknown';
  const expectedVersion = process.env.EXPECTED_VSIX_VERSION;
  const checks = [];
  const record = (name, details) => checks.push({name, status: 'passed', details});
  const writeResults = (status, extra = {}) => {
    fs.writeFileSync(path.join(out, 'checks.json'), JSON.stringify({variant, status, checks, notTested, ...extra}, null, 2));
  };

  try {
    assert(out, 'RESULTS_DIR must be supplied by the parent harness');
    assert(expectedVersion?.trim(), 'EXPECTED_VSIX_VERSION must be supplied by the parent harness');

    const target = vscode.extensions.getExtension('aryansudhir.cognispec');
    assert(target, 'VS Code extension API cannot find installed Cognispec');
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

    const expectedCommands = [
      'cognispec.createStudy',
      'cognispec.validateStudy',
      'cognispec.openStudy',
    ];
    const expectedActivationEvents = expectedCommands.map(command => `onCommand:${command}`);
    assert.deepEqual(target.packageJSON.activationEvents, expectedActivationEvents, 'Unexpected Cognispec activation events');
    record('Three command activation events declared', expectedActivationEvents);

    const declared = target.packageJSON.contributes?.commands || [];
    assert.deepEqual(declared.map(contribution => contribution.command).sort(), [...expectedCommands].sort(), 'Unexpected Cognispec command declarations');
    const registered = await vscode.commands.getCommands(true);
    for (const command of expectedCommands) {
      assert(registered.includes(command), `Missing registered command: ${command}`);
    }
    record('Three Cognispec commands declared and registered', expectedCommands);

    const configurationProperties = target.packageJSON.contributes?.configuration?.properties || {};
    const jsPsychProperty = configurationProperties['cognispec.jsPsychVersion'];
    assert(jsPsychProperty, 'Missing setting declaration: cognispec.jsPsychVersion');
    assert.equal(jsPsychProperty.type, 'string', 'cognispec.jsPsychVersion must be a string setting');
    assert.equal(jsPsychProperty.default, '8.2.1', 'Unexpected cognispec.jsPsychVersion schema default');

    const config = vscode.workspace.getConfiguration('cognispec');
    assert.equal(config.get('jsPsychVersion'), '8.2.1', 'Unexpected clean-install jsPsychVersion');
    assert.equal(config.inspect('jsPsychVersion')?.defaultValue, '8.2.1', 'Unexpected effective jsPsychVersion default');
    await config.update('jsPsychVersion', '8.2.2', vscode.ConfigurationTarget.Global);
    await delay(200);
    assert.equal(vscode.workspace.getConfiguration('cognispec').get('jsPsychVersion'), '8.2.2', 'jsPsychVersion setting did not persist');
    await config.update('jsPsychVersion', undefined, vscode.ConfigurationTarget.Global);
    await delay(200);
    assert.equal(vscode.workspace.getConfiguration('cognispec').get('jsPsychVersion'), '8.2.1', 'jsPsychVersion setting did not reset');
    record('jsPsychVersion default and round-trip', {default: '8.2.1', updated: '8.2.2', reset: true});

    if (variant === 'manifest') {
      record('VSIX manifest integrity', {main: target.packageJSON.main, version: expectedVersion, setting: 'cognispec.jsPsychVersion'});
    }

    if (variant === 'clean-state') {
      assert.equal(vscode.extensions.all.filter(extension => extension.id.toLowerCase() === 'aryansudhir.cognispec').length, 1, 'Cognispec appears more than once in a clean profile');
      assert.equal(vscode.workspace.getConfiguration('cognispec').get('jsPsychVersion'), '8.2.1', 'Clean profile jsPsychVersion default changed');
      record('Clean profile contains exactly one Cognispec extension', {jsPsychVersion: '8.2.1'});
    }

    if (variant === 'settings-isolation') {
      assert(Object.keys(configurationProperties).includes('cognispec.jsPsychVersion'), 'Cognispec settings schema lost jsPsychVersion');
      assert.equal(vscode.workspace.getConfiguration('cognispec').inspect('jsPsychVersion')?.globalValue, undefined, 'jsPsychVersion global override was not cleared');
      record('Settings schema isolation and reset', {properties: Object.keys(configurationProperties), globalOverrideCleared: true});
    }

    if (variant === 'reinstall') {
      record('CLI uninstall and reinstall lifecycle', 'Reported by parent harness; no CLI lifecycle commands are run in this suite.');
    }

    if (variant === 'duplicate-install') {
      record('Repeated CLI install remains idempotent', 'Reported by parent harness; no CLI install commands are run in this suite.');
    }

    if (variant === 'ui-settings') {
      await vscode.commands.executeCommand('workbench.action.quickOpen', '>Cognispec');
      await delay(1500);
      cp.execFileSync('scrot', [path.join(out, 'cognispec-command-palette.png')], {timeout: 15000});
      await vscode.commands.executeCommand('workbench.action.closeQuickOpen');
      record('Command palette UI screenshot captured without invoking Cognispec', 'cognispec-command-palette.png');
    }

    writeResults('passed');
    console.log(`COGNISPEC_EXTENDED_SMOKE_TEST_PASSED ${JSON.stringify({variant, checks})}`);
  } catch (error) {
    try {
      writeResults('failed', {error: String(error.stack || error)});
    } catch {}
    try {
      if (out) cp.execFileSync('scrot', [path.join(out, 'failure.png')], {timeout: 15000});
    } catch {}
    throw error;
  }
};
