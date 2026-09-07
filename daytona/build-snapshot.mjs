// Builds (or rebuilds) the Daytona snapshot used for Promptr clean-install checks.
// The image contains desktop VS Code (from packages.microsoft.com), Xvfb, Node 22 and the
// @vscode/test-electron harness dependency. It contains NO Promptr artifact: every check
// receives the published VSIX at run time so the extension under test is always current.
import { Daytona, Image } from '@daytona/sdk';

const name = process.env.SNAPSHOT_NAME || 'promptr-install-check-v1';
const daytona = new Daytona();

const image = Image.base('ubuntu:24.04')
  .env({ DEBIAN_FRONTEND: 'noninteractive', TZ: 'Etc/UTC' })
  .runCommands(
    'apt-get update && apt-get install -y --no-install-recommends ca-certificates curl gnupg unzip xvfb scrot xauth ' +
      'libgtk-3-0 libnss3 libasound2t64 libgbm1 libxss1 libxkbfile1 libsecret-1-0 libx11-xcb1 libxshmfence1 libdrm2 ' +
      'libxcomposite1 libxdamage1 libxrandr2 libatk-bridge2.0-0 libcups2 xdg-utils fonts-dejavu-core',
    'curl -fsSL https://packages.microsoft.com/keys/microsoft.asc | gpg --dearmor -o /usr/share/keyrings/microsoft.gpg && ' +
      'echo "deb [arch=amd64 signed-by=/usr/share/keyrings/microsoft.gpg] https://packages.microsoft.com/repos/code stable main" > /etc/apt/sources.list.d/vscode.list && ' +
      'apt-get update && apt-get install -y --no-install-recommends code',
    'curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y --no-install-recommends nodejs',
    'mkdir -p /opt/check && cd /opt/check && npm init -y >/dev/null && npm install @vscode/test-electron@3.1.0 --no-audit --no-fund',
    'apt-get clean && rm -rf /var/lib/apt/lists/* && /usr/share/code/bin/code --version --no-sandbox --user-data-dir /tmp/vscode-probe && rm -rf /tmp/vscode-probe',
  )
  .workdir('/opt/check');

console.log(`Building snapshot "${name}" ...`);
const started = Date.now();
const snapshot = await daytona.snapshot.create(
  { name, image, resources: { cpu: 2, memory: 3, disk: 6 } },
  { onLogs: (chunk) => process.stdout.write(chunk), timeout: 0 },
);
console.log(`\nSnapshot ready: ${snapshot.name} (${snapshot.id}) state=${snapshot.state} in ${Math.round((Date.now() - started) / 1000)}s`);
