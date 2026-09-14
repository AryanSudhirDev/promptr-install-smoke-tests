import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require = createRequire(import.meta.url);
const {verifyInstallation} = require('../imac/install-lifecycle.cjs');

const targetId = 'aryansudhir.promptr';
const expectedVersion = '1.2.3';
const installedLine = `${targetId}@${expectedVersion}`.toLowerCase();
const vsix = '/input/promptr.vsix';

function fakeCommand(script) {
  const calls = [];
  const command = (args) => {
    calls.push(args);
    const result = script(args, calls.length);
    if (result instanceof Error) throw result;
    return result;
  };
  return {command, calls};
}

test('base run: exact CLI trace and 4 calls total', () => {
  const {command, calls} = fakeCommand((args) => {
    if (args[0] === '--list-extensions' && args.length === 1) return '';
    if (args[0] === '--list-extensions') return installedLine;
    if (args[0] === '--install-extension') return 'installed foo';
    if (args[0] === '--version') return '1.90.0';
    throw new Error('unexpected args ' + args.join(' '));
  });
  const result = verifyInstallation({command, targetId, expectedVersion, variant: 'unknown', vsix});
  assert.deepEqual(calls, [
    ['--list-extensions'],
    ['--install-extension', vsix],
    ['--list-extensions', '--show-versions'],
    ['--version'],
  ]);
  assert.equal(calls.length, 4);
  assert.deepEqual(result, {
    installed: [installedLine],
    vscodeVersion: '1.90.0',
    installOutput: 'installed foo',
    lifecycle: [],
  });
});

test('wrong version published: install check fails before any lifecycle branch runs', () => {
  const {command} = fakeCommand((args) => {
    if (args[0] === '--list-extensions' && args.length === 1) return '';
    if (args[0] === '--list-extensions') return `${targetId}@9.9.9`.toLowerCase();
    if (args[0] === '--install-extension') return 'installed foo';
    return '1.90.0';
  });
  assert.throws(
    () => verifyInstallation({command, targetId, expectedVersion, variant: 'unknown', vsix}),
    (err) => err.message.includes('Published extension was not installed') && err.message.includes('9.9.9'),
  );
});

test('dirty starting profile is rejected before install is attempted', () => {
  const {command, calls} = fakeCommand((args) => {
    if (args[0] === '--list-extensions' && args.length === 1) return 'some.other-extension@1.0.0';
    return '';
  });
  assert.throws(
    () => verifyInstallation({command, targetId, expectedVersion, variant: 'unknown', vsix}),
    /Fresh extension directory was not empty/,
  );
  assert.deepEqual(calls, [['--list-extensions']]);
});

test('reinstall: uninstall leaves extension absent, then reinstall restores it, 8 calls total', () => {
  const {command, calls} = fakeCommand((args, n) => {
    if (args[0] === '--list-extensions' && args.length === 1) return '';
    if (args[0] === '--uninstall-extension') return 'uninstalled';
    if (args[0] === '--install-extension') return 'installed foo';
    if (args[0] === '--version') return '1.90.0';
    if (args[0] === '--list-extensions') {
      // calls (in order): #3 post-install, #5 post-uninstall, #7 post-reinstall
      if (n === 3) return installedLine;
      if (n === 5) return '';
      if (n === 7) return installedLine;
      throw new Error('unexpected relist at call ' + n);
    }
    throw new Error('unexpected args ' + args.join(' '));
  });
  const result = verifyInstallation({command, targetId, expectedVersion, variant: 'reinstall', vsix});
  assert.deepEqual(calls.map((a) => a[0]), [
    '--list-extensions',
    '--install-extension',
    '--list-extensions',
    '--uninstall-extension',
    '--list-extensions',
    '--install-extension',
    '--list-extensions',
    '--version',
  ]);
  assert.equal(calls.length, 8);
  assert.deepEqual(result.lifecycle, [{uninstalled: true, reinstalled: true}]);
  assert.deepEqual(result.installed, [installedLine]);
});

test('reinstall: extension remains installed after uninstall throws', () => {
  const {command} = fakeCommand((args, n) => {
    if (args[0] === '--list-extensions' && args.length === 1) return '';
    if (args[0] === '--uninstall-extension') return 'uninstalled';
    if (args[0] === '--install-extension') return 'installed foo';
    if (args[0] === '--list-extensions') return installedLine; // still present post-uninstall
    return '1.90.0';
  });
  assert.throws(
    () => verifyInstallation({command, targetId, expectedVersion, variant: 'reinstall', vsix}),
    /Extension remained installed after uninstall/,
  );
});

test('reinstall: extension missing after the reinstall attempt throws', () => {
  const {command} = fakeCommand((args, n) => {
    if (args[0] === '--list-extensions' && args.length === 1) return '';
    if (args[0] === '--uninstall-extension') return 'uninstalled';
    if (args[0] === '--install-extension') return 'installed foo';
    if (args[0] === '--list-extensions') {
      if (n === 3) return installedLine; // post-install
      if (n === 5) return ''; // post-uninstall, correctly absent
      if (n === 7) return ''; // post-reinstall, still missing -> should fail
      throw new Error('unexpected relist at call ' + n);
    }
    return '1.90.0';
  });
  assert.throws(
    () => verifyInstallation({command, targetId, expectedVersion, variant: 'reinstall', vsix}),
    /Extension did not return after reinstall/,
  );
});

test('duplicate-install: repeated install stays a single listing, 6 calls total', () => {
  const {command, calls} = fakeCommand((args) => {
    if (args[0] === '--list-extensions' && args.length === 1) return '';
    if (args[0] === '--install-extension') return 'installed foo';
    if (args[0] === '--list-extensions') return installedLine;
    if (args[0] === '--version') return '1.90.0';
    throw new Error('unexpected args ' + args.join(' '));
  });
  const result = verifyInstallation({command, targetId, expectedVersion, variant: 'duplicate-install', vsix});
  assert.deepEqual(calls.map((a) => a[0]), [
    '--list-extensions',
    '--install-extension',
    '--list-extensions',
    '--install-extension',
    '--list-extensions',
    '--version',
  ]);
  assert.equal(calls.length, 6);
  assert.deepEqual(result.lifecycle, [{secondInstall: true, uniqueListings: 1}]);
});

test('duplicate-install: a genuine duplicate listing is caught', () => {
  const {command} = fakeCommand((args) => {
    if (args[0] === '--list-extensions' && args.length === 1) return '';
    if (args[0] === '--install-extension') return 'installed foo';
    if (args[0] === '--list-extensions') return `${installedLine}\n${installedLine}`;
    return '1.90.0';
  });
  assert.throws(
    () => verifyInstallation({command, targetId, expectedVersion, variant: 'duplicate-install', vsix}),
    /Repeated install created an unexpected extension listing/,
  );
});

test('a failing CLI command propagates and stops the lifecycle immediately', () => {
  const {command, calls} = fakeCommand((args) => {
    if (args[0] === '--list-extensions' && args.length === 1) return '';
    if (args[0] === '--install-extension') return new Error('code failed: exit 1');
    return '';
  });
  assert.throws(
    () => verifyInstallation({command, targetId, expectedVersion, variant: 'unknown', vsix}),
    /code failed: exit 1/,
  );
  assert.deepEqual(calls.map((a) => a[0]), ['--list-extensions', '--install-extension']);
});
