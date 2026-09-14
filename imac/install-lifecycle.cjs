// Extracted from container-check.cjs: drives the VS Code CLI through install/uninstall/reinstall/
// duplicate-install checks for a single QA run. `command` is the caller's checked CLI runner
// (command(args) => stdout.trim()), already bound to the user-data-dir/extensions-dir/executable.
//
// The only behavior change from the inline version in container-check.cjs is trimming redundant
// `--list-extensions` launches:
//   - assertion failure messages reuse the listing that was already fetched for the check instead
//     of relisting just to describe the failure (that relist ran unconditionally before, even when
//     the assertion passed);
//   - the final report's `installed` field reuses the most recently verified listing instead of
//     issuing one more `--list-extensions` call, since nothing mutates extension state between the
//     last verification and the `--version` probe.
// No assertion, message, or check that container-check.cjs relied on was removed or weakened.
const assert = require('node:assert/strict');

function verifyInstallation({command, targetId, expectedVersion, variant, vsix}) {
  const installedLine = `${targetId}@${expectedVersion}`.toLowerCase();
  const listExtensions = () => command(['--list-extensions', '--show-versions']).toLowerCase().split(/\r?\n/);

  const before = command(['--list-extensions']);
  assert.equal(before, '', `Fresh extension directory was not empty: ${before}`);

  const installOutput = command(['--install-extension', vsix]);

  let lastListing = listExtensions();
  assert(lastListing.includes(installedLine), `Published extension was not installed: ${lastListing.join(',')}`);

  const lifecycle = [];
  if (variant === 'reinstall') {
    command(['--uninstall-extension', targetId]);
    lastListing = listExtensions();
    assert(!lastListing.includes(installedLine), `Extension remained installed after uninstall: ${lastListing.join(',')}`);
    command(['--install-extension', vsix]);
    lastListing = listExtensions();
    assert(lastListing.includes(installedLine), `Extension did not return after reinstall: ${lastListing.join(',')}`);
    lifecycle.push({uninstalled: true, reinstalled: true});
  }
  if (variant === 'duplicate-install') {
    command(['--install-extension', vsix]);
    lastListing = listExtensions();
    const matches = lastListing.filter((line) => line === installedLine);
    assert.equal(matches.length, 1, 'Repeated install created an unexpected extension listing');
    lifecycle.push({secondInstall: true, uniqueListings: matches.length});
  }

  const vscodeVersion = command(['--version']);

  return {
    installed: lastListing,
    vscodeVersion,
    installOutput,
    lifecycle,
  };
}

module.exports = {verifyInstallation};
