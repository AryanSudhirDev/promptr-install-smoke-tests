// Publishes monitor status + download history to the `data` branch so the hosted dashboard
// (GitHub Pages) can read everything without any credentials. Runs at the end of each monitor run.
// Uses only GITHUB_TOKEN; writes nothing to main.
const REPO = process.env.GITHUB_REPOSITORY || 'AryanSudhirDev/promptr-install-smoke-tests';
const TOKEN = process.env.GITHUB_TOKEN;
const BRANCH = 'data';
const API = 'https://api.github.com';
const headers = { Authorization: `Bearer ${TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };

const gh = async (path, init = {}) => {
  const res = await fetch(`${API}${path}`, { ...init, headers: { ...headers, ...(init.headers || {}) } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${path} -> ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res.json();
};

// --- 1. current published release + public download count -------------------------------------
let openvsx = { version: null, downloadCount: null };
try {
  const r = await fetch('https://open-vsx.org/api/aryansudhir/promptr', { headers: { 'Cache-Control': 'no-cache' } });
  if (r.ok) { const j = await r.json(); openvsx = { version: j.version, downloadCount: j.downloadCount }; }
} catch {}

// --- 2. today's checks on this repo ------------------------------------------------------------
const today = new Date().toISOString().slice(0, 10);
let checksToday = 0, failedToday = 0, lastRunAt = null, runsToday = 0;
try {
  const runs = await gh(`/repos/${REPO}/actions/workflows/daily-health-qa.yml/runs?per_page=30`);
  const todays = (runs?.workflow_runs || []).filter((r) => r.created_at >= `${today}T00:00:00Z`);
  runsToday = todays.length;
  lastRunAt = todays[0]?.created_at || null;
  for (const run of todays.slice(0, 12)) {
    const jobs = await gh(`/repos/${REPO}/actions/runs/${run.id}/jobs?per_page=100`);
    for (const job of jobs?.jobs || []) {
      if (!job.name.startsWith('Clean install')) continue;
      if (job.conclusion === 'success') checksToday++;
      else if (job.conclusion === 'failure') failedToday++;
    }
  }
} catch (e) { console.log('check count failed:', e.message); }

// --- 3. configured daily totals ----------------------------------------------------------------
let githubTotal = null, imacTotal = null;
githubTotal = Number(process.env.GITHUB_DAILY_TOTAL) || null;
try {
  const r = await fetch(`https://raw.githubusercontent.com/${REPO}/main/monitor-config.json?t=${Date.now()}`);
  if (r.ok) imacTotal = Number((await r.json()).imacDailyTotal) || null;
} catch {}

// --- 4. make sure the data branch exists --------------------------------------------------------
const ref = await gh(`/repos/${REPO}/git/ref/heads/${BRANCH}`);
if (!ref) {
  const main = await gh(`/repos/${REPO}/git/ref/heads/main`);
  await gh(`/repos/${REPO}/git/refs`, { method: 'POST', body: JSON.stringify({ ref: `refs/heads/${BRANCH}`, sha: main.object.sha }) });
  console.log('created data branch');
}

const getFile = async (p) => {
  const f = await gh(`/repos/${REPO}/contents/${p}?ref=${BRANCH}`);
  return f ? { sha: f.sha, text: Buffer.from(f.content, 'base64').toString('utf8') } : { sha: null, text: '' };
};
const putFile = async (p, text, sha, message) =>
  gh(`/repos/${REPO}/contents/${p}`, { method: 'PUT', body: JSON.stringify({
    message, branch: BRANCH, content: Buffer.from(text).toString('base64'), ...(sha ? { sha } : {}) }) });

// --- 5. append a history point (keep 30 days) ---------------------------------------------------
const now = new Date().toISOString();
const hist = await getFile('downloads.jsonl');
const lines = hist.text.split('\n').filter(Boolean);
const last = lines.length ? JSON.parse(lines.at(-1)) : null;
if (openvsx.downloadCount != null && (!last || last.downloadCount !== openvsx.downloadCount || Date.parse(now) - Date.parse(last.at) > 3600000)) {
  lines.push(JSON.stringify({ at: now, downloadCount: openvsx.downloadCount, version: openvsx.version, source: 'github-actions' }));
}
const cutoff = Date.now() - 30 * 86400000;
const pruned = lines.filter((l) => { try { return Date.parse(JSON.parse(l).at) >= cutoff; } catch { return false; } });
await putFile('downloads.jsonl', pruned.join('\n') + '\n', hist.sha, `history ${openvsx.downloadCount ?? '?'} [skip ci]`);

// --- 6. status snapshot -------------------------------------------------------------------------
const status = await getFile('status.json');
await putFile('status.json', JSON.stringify({
  updatedAt: now,
  openvsx,
  github: { dailyTotal: githubTotal, checksToday, failedToday, runsToday, lastRunAt },
  imac: { dailyTotal: imacTotal },
}, null, 2) + '\n', status.sha, `status [skip ci]`);

console.log(`published: downloads=${openvsx.downloadCount} githubChecksToday=${checksToday} githubTotal=${githubTotal} imacTotal=${imacTotal}`);
