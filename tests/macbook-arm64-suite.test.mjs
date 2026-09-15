import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {buildContext} from '../macbook/image.mjs';

const root = path.resolve(new URL('..', import.meta.url).pathname);
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const suites = [
  {file: 'macbook/promptr-arm64-suite.cjs', target: 'aryansudhir.promptr', marker: 'PROMPTR_EXTENDED_SMOKE_TEST_PASSED', screenshot: 'promptr-command-palette.png', commands: ['promptr.generatePrompt', 'promptr.setTemperature', 'promptr.setCustomContext']},
  {file: 'macbook/cognispec-arm64-suite.cjs', target: 'aryansudhir.cognispec', marker: 'COGNISPEC_EXTENDED_SMOKE_TEST_PASSED', screenshot: 'cognispec-command-palette.png', commands: ['cognispec.createStudy', 'cognispec.validateStudy', 'cognispec.openStudy']},
];

test('native ARM64 suites keep real extension verification contracts', () => {
  for (const suite of suites) {
    const source = read(suite.file);
    assert.match(source, /require\('vscode'\)/);
    assert.match(source, /process\.arch, 'arm64'/);
    assert.match(source, /process\.platform, 'linux'/);
    assert.match(source, /getExtension\(targetId\)/);
    assert.match(source, /EXPECTED_VSIX_VERSION/);
    assert.match(source, /Activation timed out after 30 seconds/);
    assert.match(source, /target\.activate\(\)/);
    assert.match(source, /vscode\.commands\.getCommands\(true\)/);
    for (const command of suite.commands) assert.match(source, new RegExp(command.replaceAll('.', '\\.')));
    for (const variant of ['manifest', 'clean-state', 'settings-isolation', 'ui-settings', 'reinstall', 'duplicate-install']) assert.match(source, new RegExp(`variant === '${variant}'`));
    assert.match(source, /status, checks, notTested/);
    assert.match(source, /writeResults\('failed'/);
    assert.match(source, /failure\.png/);
    assert.match(source, new RegExp(suite.marker));
    assert.match(source, /await delay\(1500\)/);
    assert.match(source, new RegExp(suite.screenshot));
    assert.doesNotMatch(source, /vscode\.commands\.executeCommand\('cognispec\.(?:createStudy|validateStudy|openStudy)'/);
  }
});

test('MacBook image context contains and selects the native suites before the harness', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'macbook-arm64-context-'));
  try {
    buildContext(tmp);
    for (const suite of suites) assert.equal(fs.readFileSync(path.join(tmp, suite.file), 'utf8'), read(suite.file));
    const dockerfile = read('macbook/Dockerfile');
    assert.match(dockerfile, /COPY macbook\/promptr-arm64-suite\.cjs macbook\/cognispec-arm64-suite\.cjs \.\//);
    const entrypoint = read('macbook/entrypoint.sh');
    assert.match(entrypoint, /aryansudhir\.promptr\)[\s\S]*cp \/opt\/check\/promptr-arm64-suite\.cjs \/opt\/check\/extended-suite\.cjs/);
    assert.match(entrypoint, /aryansudhir\.cognispec\)[\s\S]*cp \/opt\/check\/cognispec-arm64-suite\.cjs \/opt\/check\/extended-suite\.cjs/);
    assert.ok(entrypoint.indexOf('promptr-arm64-suite.cjs') < entrypoint.indexOf('node /opt/check/container-check.cjs'));
    assert.ok(entrypoint.indexOf('cognispec-arm64-suite.cjs') < entrypoint.indexOf('node /opt/check/container-check.cjs'));
  } finally {
    fs.rmSync(tmp, {recursive: true, force: true});
  }
});
