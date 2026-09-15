const vscode = require('vscode');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const {waitForSetting} = require('./wait-for-setting.cjs');

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const targetId = 'aryansudhir.promptr';
const commandIds = ['promptr.generatePrompt', 'promptr.setTemperature', 'promptr.setCustomContext'];
const configurationKeys = ['promptr.temperature', 'promptr.customContext', 'promptr.autoValidate', 'promptr.apiBase', 'promptr.backendApiUrl'];
const notTested = ['Access-token command registration', 'Authenticated prompt refinement', 'AI requests', 'Research data or study output actions', 'macOS compatibility'];

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
    assert(target, 'VS Code extension API cannot find freshly installed Promptr');
    assert.equal(target.packageJSON.version, expectedVersion, 'Installed Promptr version does not match EXPECTED_VSIX_VERSION');
    record('Fresh installed extension discovered', `${target.id}@${target.packageJSON.version}`);

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
    assert(target.isActive, 'Promptr did not become active');
    record('Extension activation completed within 30 seconds', true);

    const declared = target.packageJSON.contributes?.commands || [];
    for (const command of commandIds) assert(declared.some(contribution => contribution.command === command), `Missing command declaration: ${command}`);
    const registered = await vscode.commands.getCommands(true);
    for (const command of commandIds) assert(registered.includes(command), `Missing registered command: ${command}`);
    record('Core commands declared and registered', commandIds);

    const config = vscode.workspace.getConfiguration('promptr');
    assert.equal(config.get('temperature'), 0.3, 'Unexpected clean-install temperature');
    assert.equal(config.get('customContext'), '', 'Unexpected clean-install custom context');
    assert.equal(config.inspect('temperature')?.defaultValue, 0.3, 'Temperature schema default changed');
    assert.equal(config.inspect('customContext')?.defaultValue, '', 'Custom context schema default changed');
    record('Clean defaults available through the VS Code settings API', {temperature: 0.3, customContext: ''});
    await config.update('temperature', 0.55, vscode.ConfigurationTarget.Global);
    await waitForSetting(() => vscode.workspace.getConfiguration('promptr').get('temperature'), 0.55);
    assert.equal(vscode.workspace.getConfiguration('promptr').get('temperature'), 0.55, 'Test-only temperature override did not persist');
    await config.update('temperature', undefined, vscode.ConfigurationTarget.Global);
    await waitForSetting(() => vscode.workspace.getConfiguration('promptr').get('temperature'), 0.3);
    record('Temperature test-only global override round-trip', {updated: 0.55, reset: true});

    if (variant === 'manifest') {
      assert.equal(target.packageJSON.main, './dist/extension.js', 'Unexpected Promptr extension entrypoint');
      assert(fs.existsSync(path.join(target.extensionPath, target.packageJSON.main)), 'Compiled extension entrypoint is missing from installed VSIX');
      const properties = Object.keys(target.packageJSON.contributes?.configuration?.properties || {});
      for (const key of configurationKeys) assert(properties.includes(key), `Missing configuration property: ${key}`);
      record('VSIX manifest, compiled entrypoint, and settings schema integrity', {main: target.packageJSON.main, properties});
    }

    if (variant === 'clean-state') {
      assert.equal(vscode.extensions.all.filter(extension => extension.id.toLowerCase() === targetId).length, 1, 'Promptr appears more than once in a clean profile');
      assert.equal(config.inspect('temperature')?.globalValue, undefined, 'Clean profile has a temperature override');
      assert.equal(config.inspect('customContext')?.globalValue, undefined, 'Clean profile has a custom-context override');
      assert.equal(config.get('autoValidate'), true, 'Clean profile autoValidate default changed');
      record('Clean profile has one extension and no persisted settings overrides', {autoValidate: true});
    }

    if (variant === 'settings-isolation') {
      await config.update('temperature', 0.45, vscode.ConfigurationTarget.Global);
      await waitForSetting(() => vscode.workspace.getConfiguration('promptr').get('temperature'), 0.45);
      await config.update('customContext', 'arm64-container-settings-isolation', vscode.ConfigurationTarget.Global);
      await waitForSetting(() => vscode.workspace.getConfiguration('promptr').get('customContext'), 'arm64-container-settings-isolation');
      assert.equal(vscode.workspace.getConfiguration('promptr').get('autoValidate'), true, 'Unrelated autoValidate setting changed');
      await config.update('customContext', undefined, vscode.ConfigurationTarget.Global);
      await config.update('temperature', undefined, vscode.ConfigurationTarget.Global);
      await waitForSetting(() => vscode.workspace.getConfiguration('promptr').get('customContext'), '');
      await waitForSetting(() => vscode.workspace.getConfiguration('promptr').get('temperature'), 0.3);
      assert.equal(config.inspect('customContext')?.globalValue, undefined, 'Custom-context override was not cleared');
      assert.equal(config.inspect('temperature')?.globalValue, undefined, 'Temperature override was not cleared');
      record('Settings isolation writes and clears two test-only global overrides', {temperature: 0.45, customContextReset: true});
    }

    if (variant === 'reinstall') record('CLI uninstall and reinstall lifecycle was verified before suite execution', true);
    if (variant === 'duplicate-install') record('CLI repeated-install idempotence was verified before suite execution', true);

    if (variant === 'ui-settings') {
      const document = await vscode.workspace.openTextDocument({language: 'plaintext', content: 'Native ARM64 Linux UI smoke test. No token, AI request, research data, or study output action is used.\n'});
      await vscode.window.showTextDocument(document);
      await vscode.commands.executeCommand('workbench.action.quickOpen', '>Promptr');
      await delay(1500);
      cp.execFileSync('scrot', [path.join(out, 'promptr-command-palette.png')], {timeout: 15000});
      await vscode.commands.executeCommand('workbench.action.closeQuickOpen');
      record('UI-only command palette screenshot captured', 'promptr-command-palette.png');
    }

    writeResults('passed');
    console.log(`PROMPTR_EXTENDED_SMOKE_TEST_PASSED ${JSON.stringify({variant, checks})}`);
  } catch (error) {
    try { if (out) writeResults('failed', {error: String(error.stack || error)}); } catch {}
    try { if (out) cp.execFileSync('scrot', [path.join(out, 'failure.png')], {timeout: 15000}); } catch {}
    throw error;
  }
};
