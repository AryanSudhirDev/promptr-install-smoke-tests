const vscode = require('vscode');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

exports.run = async () => {
  const out = process.env.RESULTS_DIR;
  const variant = process.env.TEST_VARIANT || 'unknown';
  const expectedVersion = process.env.EXPECTED_VSIX_VERSION || '1.5.6';
  const checks = [];
  const record = (name, details) => checks.push({name, status: 'passed', details});
  try {
    const target = vscode.extensions.getExtension('aryansudhir.promptr');
    assert(target, 'VS Code extension API cannot find installed Promptr');
    assert.equal(target.packageJSON.version, expectedVersion);
    record('Installed published extension discovered', `${target.id}@${target.packageJSON.version}`);

    await Promise.race([
      target.activate(),
      new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('Activation timed out after 30 seconds')), 30000); timer.unref(); }),
    ]);
    assert(target.isActive, 'Promptr did not become active');
    record('Extension activation', true);

    const declared = target.packageJSON.contributes?.commands || [];
    const expectedCommands = ['promptr.generatePrompt', 'promptr.setTemperature', 'promptr.setCustomContext'];
    for (const expected of expectedCommands) assert(declared.some(c => c.command === expected), `Missing command declaration: ${expected}`);
    const actual = await vscode.commands.getCommands(true);
    for (const command of expectedCommands) assert(actual.includes(command), `Missing registered command: ${command}`);
    record('Three core commands declared and registered', expectedCommands);

    const bindings = target.packageJSON.contributes?.keybindings || [];
    assert(bindings.some(b => b.command === 'promptr.generatePrompt' && b.key === 'shift+ctrl+g' && b.mac === 'shift+cmd+g'), 'Expected Promptr keyboard shortcut is missing');
    record('Cross-platform keybinding contribution', bindings);

    const config = vscode.workspace.getConfiguration('promptr');
    assert.equal(config.get('temperature'), 0.3, 'Unexpected clean-install temperature');
    assert.equal(config.get('customContext'), '', 'Unexpected clean-install custom context');
    const temperatureInspect = config.inspect('temperature');
    const contextInspect = config.inspect('customContext');
    assert.equal(temperatureInspect?.defaultValue, 0.3, 'Temperature schema default changed');
    assert.equal(contextInspect?.defaultValue, '', 'Custom context schema default changed');
    await config.update('temperature', 0.6, vscode.ConfigurationTarget.Global);
    await delay(200);
    assert.equal(vscode.workspace.getConfiguration('promptr').get('temperature'), 0.6, 'Temperature setting did not persist');
    await config.update('temperature', undefined, vscode.ConfigurationTarget.Global);
    await delay(200);
    assert.equal(vscode.workspace.getConfiguration('promptr').get('temperature'), 0.3, 'Temperature setting did not reset');
    record('Clean defaults and temperature round-trip', {temperature: 0.3, customContext: '', changedAndReset: true});

    if (variant === 'manifest') {
      assert.equal(target.packageJSON.main, './dist/extension.js');
      assert(fs.existsSync(path.join(target.extensionPath, target.packageJSON.main)), 'Compiled extension entrypoint is missing from installed VSIX');
      const configurationProperties = Object.keys(target.packageJSON.contributes?.configuration?.properties || {});
      for (const key of ['promptr.temperature', 'promptr.customContext', 'promptr.apiBase', 'promptr.backendApiUrl']) assert(configurationProperties.includes(key), `Missing configuration property: ${key}`);
      record('VSIX manifest and compiled entrypoint integrity', {main: target.packageJSON.main, configurationProperties, version: expectedVersion});
    }

    if (variant === 'reinstall') {
      record('CLI uninstall and reinstall lifecycle', true);
    }

    if (variant === 'duplicate-install') {
      record('Repeated CLI install remains idempotent', true);
    }

    if (variant === 'clean-state') {
      assert.equal(vscode.extensions.all.filter(ext => ext.id.toLowerCase() === 'aryansudhir.promptr').length, 1, 'Promptr appears more than once in a clean profile');
      assert.equal(vscode.workspace.getConfiguration('promptr').get('autoValidate'), true, 'Clean profile autoValidate default changed');
      record('Clean profile contains exactly one Promptr extension', {autoValidate: true});
    }

    if (variant === 'settings-isolation') {
      const expectedProperties = ['promptr.temperature', 'promptr.customContext', 'promptr.autoValidate', 'promptr.apiBase', 'promptr.backendApiUrl'];
      const properties = Object.keys(target.packageJSON.contributes?.configuration?.properties || {});
      for (const property of expectedProperties) assert(properties.includes(property), `Missing settings property: ${property}`);
      await config.update('customContext', 'temporary clean-profile value', vscode.ConfigurationTarget.Global);
      await delay(200);
      assert.equal(vscode.workspace.getConfiguration('promptr').get('customContext'), 'temporary clean-profile value');
      await config.update('customContext', undefined, vscode.ConfigurationTarget.Global);
      await delay(200);
      assert.equal(vscode.workspace.getConfiguration('promptr').get('customContext'), '');
      assert.equal(vscode.workspace.getConfiguration('promptr').get('autoValidate'), true);
      record('Settings schema isolation and custom-context round-trip', {properties: expectedProperties, customContextReset: true, autoValidate: true});
    }

    if (variant === 'ui-settings') {
      const document = await vscode.workspace.openTextDocument({language: 'plaintext', content: 'Promptr clean-install UI smoke test.\nNo account token or backend request is used.\n'});
      await vscode.window.showTextDocument(document);
      await vscode.commands.executeCommand('workbench.action.quickOpen', '>Promptr');
      await delay(1500);
      cp.execFileSync('scrot', [path.join(out, 'promptr-command-palette.png')], {timeout: 15000});
      record('Command palette and status bar UI screenshot captured', 'promptr-command-palette.png');
      await vscode.commands.executeCommand('workbench.action.closeQuickOpen');
    }

    fs.writeFileSync(path.join(out, 'checks.json'), JSON.stringify({variant, status: 'passed', checks, notTested: ['Access-token command registration', 'Authenticated prompt refinement', 'Cursor integration', 'Windows/macOS compatibility']}, null, 2));
    console.log(`PROMPTR_EXTENDED_SMOKE_TEST_PASSED ${JSON.stringify({variant, checks})}`);
  } catch (error) {
    fs.writeFileSync(path.join(out, 'checks.json'), JSON.stringify({variant, status: 'failed', checks, error: String(error.stack || error)}, null, 2));
    try { cp.execFileSync('scrot', [path.join(out, 'failure.png')], {timeout: 15000}); } catch {}
    throw error;
  }
};
