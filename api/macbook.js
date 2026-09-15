// Only this QA repository is writable. Credentials never leave the server.
// Public GET exposes configuration only: enabled/threshold/interval/requireAC/requireHome.
// It must never expose this MacBook's live battery, network, presence, or run status.
import { timingSafeEqual } from 'node:crypto';
const REPO = process.env.QA_REPO || 'AryanSudhirDev/promptr-install-smoke-tests';
const CONFIG_PATH = 'macbook-config.json';
const ORIGINS = new Set(['https://aryansudhirdev.github.io', 'https://promptr-qa-dashboard.vercel.app',
  'http://localhost:4321', 'http://localhost:4322', 'http://localhost:4323']);
const FIELDS = ['enabled', 'minBatteryPercent', 'pollIntervalMinutes', 'requireAC', 'requireHome', 'promptrDailyTotal', 'cognispecDailyTotal'];
const DEFAULT_TARGETS = {promptrDailyTotal:1400,cognispecDailyTotal:1189};
const isBool = v => typeof v === 'boolean';
const isIntInRange = (v, min, max) => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;

// Strict: exactly these five fields, correct types, no coercion.
function validateSettings(s) {
  if (!s || typeof s !== 'object' || Array.isArray(s)) return null;
  const keys = Object.keys(s);
  if (keys.length !== FIELDS.length || !FIELDS.every(f => keys.includes(f))) return null;
  if (!isBool(s.enabled)) return null;
  if (!isIntInRange(s.minBatteryPercent, 10, 95)) return null;
  if (!isIntInRange(s.pollIntervalMinutes, 1, 60)) return null;
  if (!isBool(s.requireAC)) return null;
  if (!isBool(s.requireHome)) return null;
  if (!isIntInRange(s.promptrDailyTotal, 0, 1400)) return null;
  if (!isIntInRange(s.cognispecDailyTotal, 0, 1189)) return null;
  return { enabled: s.enabled, minBatteryPercent: s.minBatteryPercent, pollIntervalMinutes: s.pollIntervalMinutes, requireAC: s.requireAC, requireHome: s.requireHome, promptrDailyTotal:s.promptrDailyTotal, cognispecDailyTotal:s.cognispecDailyTotal };
}
function extractSettings(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return null;
  return validateSettings({ enabled: config.enabled, minBatteryPercent: config.minBatteryPercent,
    pollIntervalMinutes: config.pollIntervalMinutes, requireAC: config.requireAC, requireHome: config.requireHome,
    promptrDailyTotal: config.promptrDailyTotal ?? DEFAULT_TARGETS.promptrDailyTotal,
    cognispecDailyTotal: config.cognispecDailyTotal ?? DEFAULT_TARGETS.cognispecDailyTotal });
}
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
    let settings = null;
    if (writable) {
      try {
        const cur = await gh(`/contents/${CONFIG_PATH}`);
        settings = extractSettings(JSON.parse(Buffer.from(cur.content, 'base64').toString('utf8')));
      } catch {}
    }
    return res.status(200).json({ writable, repo: REPO, settings });
  }
  if (req.method !== 'POST') { res.setHeader('Allow', 'GET, POST, OPTIONS'); return res.status(405).json({ error: 'method not allowed' }); }
  if (!writable) return res.status(503).json({ error: 'saving is not configured on the server' });
  if (!authorized(req.headers['x-dash-key'])) return res.status(401).json({ error: 'wrong or missing dashboard key' });
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: 'invalid JSON' }); } }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return res.status(400).json({ error: 'invalid request body' });
  const bodyKeys = Object.keys(body);
  if (bodyKeys.length !== 1 || bodyKeys[0] !== 'settings') return res.status(400).json({ error: 'body must contain only settings' });
  const next = validateSettings(body.settings);
  if (!next) return res.status(400).json({ error: 'settings must include the five power/home fields plus promptrDailyTotal (integer 0-1400) and cognispecDailyTotal (integer 0-1189), with no extra fields' });
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const cur = await gh(`/contents/${CONFIG_PATH}`);
      let config; try { config = JSON.parse(Buffer.from(cur.content, 'base64').toString('utf8')); } catch { config = null; }
      if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('invalid stored config');
      if (FIELDS.every(field => config[field] === next[field])) return res.status(200).json({ ok: true, settings: next });
      // Preserve any unrelated fields that may exist alongside the five known settings.
      const merged = { ...config, ...next };
      try {
        await gh(`/contents/${CONFIG_PATH}`, { method: 'PUT', body: JSON.stringify({
          message: 'Update MacBook monitor settings [skip ci]',
          content: Buffer.from(JSON.stringify(merged, null, 2) + '\n').toString('base64'), sha: cur.sha,
        }) });
        break;
      } catch (e) { if (e.status !== 409 || attempt === 1) throw e; }
    }
    return res.status(200).json({ ok: true, settings: next });
  } catch (e) {
    if (e.status === 409) return res.status(409).json({ error: 'settings changed elsewhere; refresh and retry' });
    if (e.status === 401 || e.status === 403) return res.status(502).json({ error: 'server GitHub access rejected; check its token and permissions' });
    return res.status(502).json({ error: 'could not confirm the GitHub update; refresh before retrying' });
  }
}
