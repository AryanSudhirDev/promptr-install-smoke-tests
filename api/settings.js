// Only this QA repository is writable. Credentials never leave the server.
import { timingSafeEqual } from 'node:crypto';
const REPO = process.env.QA_REPO || 'AryanSudhirDev/promptr-install-smoke-tests';
const ORIGINS = new Set(['https://aryansudhirdev.github.io', 'https://promptr-qa-dashboard.vercel.app',
  'http://localhost:4321', 'http://localhost:4322', 'http://localhost:4323']);
const validTotal = (n, target = 'imac') => typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= (target === 'github' ? 1000 : 8000);
async function gh(path, init = {}) {
  const response = await fetch(`https://api.github.com/repos/${REPO}${path}`, {
    ...init, signal: AbortSignal.timeout(10000), headers: {
      Authorization: `Bearer ${process.env.GH_TOKEN}`, Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'promptr-qa-dashboard',
    },
  });
  if (!response.ok) { const e = new Error('GitHub request failed'); e.status = response.status; throw e; }
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}
function authorized(key) {
  if (typeof key !== 'string' || !process.env.DASH_KEY) return false;
  const a = Buffer.from(key), b = Buffer.from(process.env.DASH_KEY);
  return a.length === b.length && timingSafeEqual(a, b);
}
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Vary', 'Origin');
  const origin = req.headers.origin;
  if (origin && !ORIGINS.has(origin)) return res.status(403).json({ error: 'origin not allowed' });
  if (origin) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'content-type, x-dash-key');
  if (req.method === 'OPTIONS') return res.status(204).end();
  const writable = Boolean(process.env.GH_TOKEN && process.env.DASH_KEY);
  if (req.method === 'GET') {
    const settings = { github: null, imac: null };
    if (writable) {
      const results = await Promise.allSettled([
        gh('/actions/variables/MONITOR_CHECKS_PER_DAY'), gh('/contents/monitor-config.json'),
      ]);
      if (results[0].status === 'fulfilled') {
        const n = Number(results[0].value.value); if (validTotal(n, 'github')) settings.github = n;
      }
      if (results[1].status === 'fulfilled') {
        try { const n = JSON.parse(Buffer.from(results[1].value.content, 'base64').toString()).imacDailyTotal;
          if (validTotal(n)) settings.imac = n;
        } catch {}
      }
    }
    return res.status(200).json({ writable, repo: REPO, settings });
  }
  if (req.method !== 'POST') { res.setHeader('Allow', 'GET, POST, OPTIONS'); return res.status(405).json({ error: 'method not allowed' }); }
  if (!writable) return res.status(503).json({ error: 'saving is not configured on the server' });
  if (!authorized(req.headers['x-dash-key'])) return res.status(401).json({ error: 'wrong or missing dashboard key' });
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: 'invalid JSON' }); } }
  const { target, total } = body || {};
  if (!['github', 'imac'].includes(target)) return res.status(400).json({ error: 'target must be github or imac' });
  if (!validTotal(total, target)) return res.status(400).json({ error: 'total must be a whole number from 1 to ' + (target === 'github' ? 1000 : 8000) });
  try {
    if (target === 'github') {
      await gh('/actions/variables/MONITOR_CHECKS_PER_DAY', { method: 'PATCH',
        body: JSON.stringify({ name: 'MONITOR_CHECKS_PER_DAY', value: String(total) }) });
    } else {
      // Preserve unrelated configuration and retry once when another writer changes its SHA.
      for (let attempt = 0; attempt < 2; attempt++) {
        const cur = await gh('/contents/monitor-config.json');
        const config = JSON.parse(Buffer.from(cur.content, 'base64').toString('utf8'));
        if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('invalid config');
        if (config.imacDailyTotal === total) break;
        config.imacDailyTotal = total;
        try {
          await gh('/contents/monitor-config.json', { method: 'PUT', body: JSON.stringify({
            message: `Set iMac checks per day to ${total} [skip ci]`,
            content: Buffer.from(JSON.stringify(config, null, 2) + '\n').toString('base64'), sha: cur.sha,
          }) });
          break;
        } catch (e) { if (e.status !== 409 || attempt === 1) throw e; }
      }
    }
    return res.status(200).json({ ok: true, target, total });
  } catch (e) {
    if (e.status === 409) return res.status(409).json({ error: 'settings changed elsewhere; refresh and retry' });
    if (e.status === 401 || e.status === 403) return res.status(502).json({ error: 'server GitHub access rejected; check its token and permissions' });
    return res.status(502).json({ error: 'could not confirm the GitHub update; refresh before retrying' });
  }
}
