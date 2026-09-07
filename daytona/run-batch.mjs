// Orchestrates a batch of Promptr clean-install checks in disposable Daytona sandboxes.
//
// 1. Resolve the currently published Promptr release on Open VSX (one API call) and fetch the
//    VSIX once, verifying its SHA-256 against the registry.
// 2. For each check: create a fresh sandbox from the prebuilt snapshot, upload the VSIX and the
//    harness, run the clean-install check under Xvfb, pull back the report, delete the sandbox.
// 3. Write a batch summary. Exit non-zero if any check failed.
//
// Environment:
//   DAYTONA_API_KEY   required
//   CHECK_COUNT       checks in this batch (default 8, max 60)
//   CONCURRENCY       sandboxes at once (default 3; Tier 1 allows 10 vCPU / 10 GiB live)
//   SNAPSHOT_NAME     default promptr-install-check-v1
//   BATCH_ID          label for this batch (default: timestamp)
//   OUTPUT_DIR        where reports go (default ./daytona-results)
import { Daytona } from '@daytona/sdk';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const checkCount = Math.max(1, Math.min(60, Number(process.env.CHECK_COUNT || 8)));
const concurrency = Math.max(1, Math.min(3, Number(process.env.CONCURRENCY || 3)));
const snapshotName = process.env.SNAPSHOT_NAME || 'promptr-install-check-v1';
const batchId = process.env.BATCH_ID || new Date().toISOString().replace(/[-:]/g, '').slice(0, 15);
const outputDir = path.resolve(process.env.OUTPUT_DIR || 'daytona-results');
const variants = ['manifest', 'clean-state', 'settings-isolation', 'ui-settings', 'reinstall', 'duplicate-install'];
const REMOTE = '/opt/check/work';
const HOURLY_RATE_USD = 2 * 0.0504 + 3 * 0.0162; // 2 vCPU + 3 GiB, per Daytona pricing page

fs.mkdirSync(outputDir, { recursive: true });

async function fetchJson(url) {
  const res = await fetch(url, { headers: { 'Cache-Control': 'no-cache' } });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json();
}

// ---- 1. Resolve and fetch the published release once ---------------------------------------
const registry = await fetchJson('https://open-vsx.org/api/aryansudhir/promptr');
const version = registry.version;
const vsixUrl = registry.files.download;
const expectedSha = (await (await fetch(registry.files.sha256)).text()).trim();
if (!/^[0-9a-f]{64}$/.test(expectedSha)) throw new Error('Registry did not return a valid sha256');
const fetchedAt = new Date().toISOString();
const vsixRes = await fetch(vsixUrl, { headers: { 'Cache-Control': 'no-cache' } });
if (!vsixRes.ok) throw new Error(`VSIX download failed: HTTP ${vsixRes.status}`);
const vsix = Buffer.from(await vsixRes.arrayBuffer());
const actualSha = crypto.createHash('sha256').update(vsix).digest('hex');
if (actualSha !== expectedSha) throw new Error(`VSIX hash mismatch: ${actualSha} != ${expectedSha}`);
console.log(`Published Promptr ${version}: ${vsix.length} bytes, sha256 ${expectedSha} (fetched once at ${fetchedAt})`);

const harnessFiles = [
  { source: path.join(here, 'sandbox-check.cjs'), destination: `${REMOTE}/sandbox-check.cjs` },
  { source: path.join(repoRoot, 'extended-suite.cjs'), destination: `${REMOTE}/extended-suite.cjs` },
  { source: path.join(repoRoot, 'helper', 'index.cjs'), destination: `${REMOTE}/helper/index.cjs` },
  { source: path.join(repoRoot, 'helper', 'package.json'), destination: `${REMOTE}/helper/package.json` },
];

// ---- 2. Run checks --------------------------------------------------------------------------
const daytona = new Daytona();
const jobs = Array.from({ length: checkCount }, (_, i) => ({
  index: i,
  id: `${batchId}-${String(i).padStart(2, '0')}`,
  variant: variants[i % variants.length],
}));
const results = [];

async function runOne(job) {
  const started = Date.now();
  const record = { id: job.id, variant: job.variant, status: 'error', sandboxId: null, seconds: null, estimatedUsd: null, error: null };
  let sandbox;
  try {
    sandbox = await daytona.create({
      snapshot: snapshotName,
      ephemeral: true,
      ttlMinutes: 20,
      labels: { purpose: 'promptr-install-check', batch: batchId, variant: job.variant },
      envVars: { DEBIAN_FRONTEND: 'noninteractive' },
    }, { timeout: 120 });
    record.sandboxId = sandbox.id;
    await sandbox.process.executeCommand(`mkdir -p ${REMOTE}/input ${REMOTE}/helper`, '/', undefined, 60);
    await sandbox.fs.uploadFiles([
      ...harnessFiles.map((f) => ({ source: fs.readFileSync(f.source), destination: f.destination })),
      { source: vsix, destination: `${REMOTE}/input/promptr.vsix` },
    ], 300);
    const env = {
      TEST_VARIANT: job.variant,
      TEST_RUN: job.id,
      BATCH_ID: batchId,
      DAYTONA_SANDBOX_ID: sandbox.id,
      EXPECTED_VSIX_VERSION: version,
      EXPECTED_VSIX_SHA256: expectedSha,
      PROMPTR_VSIX_URL: vsixUrl,
      VSIX_FETCHED_AT: fetchedAt,
    };
    const exec = await sandbox.process.executeCommand(
      `cd ${REMOTE} && xvfb-run -a --server-args='-screen 0 1280x900x24' node sandbox-check.cjs > check.log 2>&1; echo "exit=$?" >> check.log; tar czf results.tgz results check.log 2>/dev/null || tar czf results.tgz check.log; tail -n 1 check.log`,
      REMOTE, env, 600,
    );
    const exitLine = (exec.result || '').trim();
    const tgz = await sandbox.fs.downloadFile(`${REMOTE}/results.tgz`, 120);
    const localDir = path.join(outputDir, job.id);
    fs.mkdirSync(localDir, { recursive: true });
    fs.writeFileSync(path.join(localDir, 'results.tgz'), tgz);
    record.status = exitLine === 'exit=0' ? 'passed' : 'failed';
    if (record.status !== 'passed') record.error = `check exited: ${exitLine || exec.exitCode}`;
  } catch (error) {
    record.error = String(error?.message || error);
  } finally {
    if (sandbox) {
      try { await daytona.delete(sandbox, 60); } catch (e) { record.error = (record.error ? record.error + '; ' : '') + `delete failed: ${e.message}`; }
    }
    record.seconds = Math.round((Date.now() - started) / 10) / 100;
    record.estimatedUsd = Math.round((record.seconds / 3600) * HOURLY_RATE_USD * 10000) / 10000;
    results.push(record);
    console.log(`[${results.length}/${checkCount}] ${record.id} ${record.variant}: ${record.status}${record.error ? ' (' + record.error + ')' : ''} in ${record.seconds}s (~$${record.estimatedUsd})`);
  }
}

const queue = [...jobs];
await Promise.all(Array.from({ length: concurrency }, async () => {
  while (queue.length) await runOne(queue.shift());
}));

// ---- 3. Summary -----------------------------------------------------------------------------
results.sort((a, b) => a.id.localeCompare(b.id));
const passed = results.filter((r) => r.status === 'passed').length;
const totalUsd = Math.round(results.reduce((s, r) => s + (r.estimatedUsd || 0), 0) * 10000) / 10000;
const summary = { batchId, snapshot: snapshotName, version, sha256: expectedSha, checkCount, passed, failed: checkCount - passed, concurrency, estimatedUsd: totalUsd, results };
fs.writeFileSync(path.join(outputDir, 'summary.json'), JSON.stringify(summary, null, 2));
console.log(`\nBatch ${batchId}: ${passed}/${checkCount} passed, ~$${totalUsd} estimated compute`);
if (process.env.GITHUB_STEP_SUMMARY) {
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, [
    `## Daytona clean-install checks (batch ${batchId})`,
    `- Release under test: Promptr ${version} (sha256 ${expectedSha}), fetched once from Open VSX`,
    `- Checks: ${passed}/${checkCount} passed, ${concurrency} sandboxes at a time, snapshot \`${snapshotName}\``,
    `- Estimated compute: ~$${totalUsd} (2 vCPU / 3 GiB per sandbox, per-second billing)`,
    '',
    '| Check | Variant | Result | Seconds | Sandbox |',
    '|---|---|---|---|---|',
    ...results.map((r) => `| ${r.id} | ${r.variant} | ${r.status}${r.error ? ' - ' + r.error.replace(/\|/g, '/') : ''} | ${r.seconds} | ${r.sandboxId || ''} |`),
    '',
  ].join('\n'));
}
process.exitCode = passed === checkCount ? 0 : 1;
