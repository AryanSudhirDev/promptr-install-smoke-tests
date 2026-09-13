// Publishes monitor status + per-extension download history to the `data` branch so the hosted
// dashboard can read everything without credentials. Runs at the end of each GitHub monitor run.
// Uses only GITHUB_TOKEN; writes nothing to main.
const REPO = process.env.GITHUB_REPOSITORY || 'AryanSudhirDev/promptr-install-smoke-tests';
const TOKEN = process.env.GITHUB_TOKEN;
const BRANCH = 'data';
const API = 'https://api.github.com';
const EXTENSIONS = {
  promptr: { namespace: 'aryansudhir', name: 'promptr', history: 'downloads.jsonl' },
  cognispec: { namespace: 'aryansudhir', name: 'cognispec', history: 'downloads-cognispec.jsonl' },
};
const headers = { Authorization: `Bearer ${TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
const gh = async (path, init = {}) => {
  const res = await fetch(`${API}${path}`, { ...init, signal: AbortSignal.timeout(15000), headers: { ...headers, ...(init.headers || {}) } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${path} -> ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res.json();
};
const openvsx = {};
for (const [key, extension] of Object.entries(EXTENSIONS)) {
  openvsx[key] = { version: null, downloadCount: null };
  try {
    const r = await fetch(`https://open-vsx.org/api/${extension.namespace}/${extension.name}`, { signal: AbortSignal.timeout(15000), headers: { 'Cache-Control': 'no-cache' } });
    if (r.ok) {
      const j = await r.json();
      if (Number.isSafeInteger(j.downloadCount) && j.downloadCount >= 0) {
        openvsx[key] = { version: typeof j.version === 'string' ? j.version : null, downloadCount: j.downloadCount };
      }
    }
  } catch {}
}
// Today's GitHub-hosted Promptr checks. Cognispec currently runs on the shared iMac only.
const today = new Date().toISOString().slice(0, 10);
let checksToday = 0, failedToday = 0, lastRunAt = null, runsToday = 0, countsComplete = true;
try {
  const todays = [];
  for (let page = 1; ; page++) {
    const result = await gh(`/repos/${REPO}/actions/workflows/daily-health-qa.yml/runs?per_page=100&page=${page}`);
    if (!result || !Array.isArray(result.workflow_runs)) throw new Error('runs unavailable');
    const batch = result.workflow_runs;
    todays.push(...batch.filter(r => r.created_at >= today + 'T00:00:00Z'));
    if (batch.length < 100 || batch.some(r => r.created_at < today + 'T00:00:00Z')) break;
  }
  runsToday = todays.length;
  lastRunAt = todays[0]?.created_at || null;
  for (const run of todays) {
    for (let page = 1; ; page++) {
      const result = await gh(`/repos/${REPO}/actions/runs/${run.id}/jobs?per_page=100&page=${page}`);
      if (!result || !Array.isArray(result.jobs)) throw new Error('jobs unavailable');
      for (const job of result.jobs) {
        if (!job.name.startsWith('Clean install')) continue;
        if (job.conclusion === 'success') checksToday++;
        else if (['failure', 'timed_out', 'cancelled', 'action_required'].includes(job.conclusion)) failedToday++;
      }
      if (result.jobs.length < 100) break;
    }
  }
} catch (e) {
  countsComplete = false; checksToday = null; failedToday = null;
  console.log('check count failed:', e.message);
}
// Read both iMac target settings from the repository.
let imacTotal = null, cognispecTotal = null;
try {
  const r = await fetch(`https://raw.githubusercontent.com/${REPO}/main/monitor-config.json?t=${Date.now()}`, { signal: AbortSignal.timeout(15000) });
  if (r.ok) {
    const config = await r.json();
    const toRate = n => Number.isInteger(n) && n >= 0 && n <= 8000 ? n : null;
    imacTotal = toRate(config.imacDailyTotal);
    cognispecTotal = toRate(config.cognispecDailyTotal);
  }
} catch {}
// Make sure the data branch exists.
const ref = await gh(`/repos/${REPO}/git/ref/heads/${BRANCH}`);
if (!ref) {
  const main = await gh(`/repos/${REPO}/git/ref/heads/main`);
  await gh(`/repos/${REPO}/git/refs`, { method: 'POST', body: JSON.stringify({ ref: `refs/heads/${BRANCH}`, sha: main.object.sha }) });
  console.log('created data branch');
}
const getFile = async p => {
  const f = await gh(`/repos/${REPO}/contents/${p}?ref=${BRANCH}`);
  return f ? { sha: f.sha, text: Buffer.from(f.content, 'base64').toString('utf8') } : { sha: null, text: '' };
};
const putFile = async (p, text, sha, message) => gh(`/repos/${REPO}/contents/${p}`, { method: 'PUT', body: JSON.stringify({ message, branch: BRANCH, content: Buffer.from(text).toString('base64'), ...(sha ? { sha } : {}) }) });
// Append one independently retained history point per extension and keep 30 days.
const now = new Date().toISOString();
const cutoff = Date.now() - 30 * 86400000;
for (const [key, extension] of Object.entries(EXTENSIONS)) {
  const hist = await getFile(extension.history);
  const lines = hist.text.split('\n').filter(Boolean);
  let last = null;
  try { last = lines.length ? JSON.parse(lines.at(-1)) : null; } catch {}
  const reading = openvsx[key];
  if (reading.downloadCount != null && (!last || last.downloadCount !== reading.downloadCount || Date.parse(now) - Date.parse(last.at) > 3600000)) {
    lines.push(JSON.stringify({ at: now, downloadCount: reading.downloadCount, version: reading.version, source: 'github-actions', extension: key }));
  }
  const pruned = lines.filter(line => { try { return Date.parse(JSON.parse(line).at) >= cutoff; } catch { return false; } });
  await putFile(extension.history, pruned.join('\n') + (pruned.length ? '\n' : ''), hist.sha, `${key} history ${reading.downloadCount ?? '?'} [skip ci]`);
}
// Keep `openvsx` as the legacy Promptr object while exposing both extensions explicitly.
const status = await getFile('status.json');
await putFile('status.json', JSON.stringify({
  updatedAt: now,
  openvsx: openvsx.promptr,
  extensions: openvsx,
  github: { dailyTotal: Number(process.env.GITHUB_DAILY_TOTAL) || null, checksToday, failedToday, runsToday, lastRunAt, countsComplete, day: today },
  imac: { dailyTotal: imacTotal, targets: { promptr: imacTotal, cognispec: cognispecTotal } },
  cognispec: { dailyTotal: cognispecTotal },
}, null, 2) + '\n', status.sha, `status [skip ci]`);
console.log(`published: promptrDownloads=${openvsx.promptr.downloadCount} cognispecDownloads=${openvsx.cognispec.downloadCount} githubChecksToday=${checksToday} promptrImacTotal=${imacTotal} cognispecImacTotal=${cognispecTotal}`);
