// Serverless endpoint that changes the monitor rates.
// The GitHub token lives only in Vercel's environment, never in the browser or the repo.
// Writes require a short dashboard key (also an env var) so the public URL cannot be used by anyone.
//
// POST /api/settings   { "target": "github" | "imac", "total": 1-1000 }
// header: x-dash-key: <DASH_KEY>

const REPO = process.env.QA_REPO || 'AryanSudhirDev/promptr-install-smoke-tests';

async function gh(path, init = {}) {
  const res = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${process.env.GH_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'promptr-qa-dashboard',
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

export default async function handler(req, res) {
  if (req.method === 'GET') {
    // lets the page discover whether this deployment can write
    return res.status(200).json({ writable: Boolean(process.env.GH_TOKEN && process.env.DASH_KEY), repo: REPO });
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  if (!process.env.GH_TOKEN || !process.env.DASH_KEY) {
    return res.status(500).json({ error: 'server is missing GH_TOKEN or DASH_KEY' });
  }
  const key = req.headers['x-dash-key'];
  if (!key || key !== process.env.DASH_KEY) return res.status(401).json({ error: 'wrong or missing dashboard key' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  const target = body?.target;
  const total = Math.round(Number(body?.total));
  if (!Number.isFinite(total) || total < 1 || total > 1000) return res.status(400).json({ error: 'total must be 1-1000' });

  try {
    if (target === 'github') {
      await gh(`/repos/${REPO}/actions/variables/MONITOR_CHECKS_PER_DAY`, {
        method: 'PATCH',
        body: JSON.stringify({ name: 'MONITOR_CHECKS_PER_DAY', value: String(total) }),
      });
      return res.status(200).json({ ok: true, target, total });
    }
    if (target === 'imac') {
      const cur = await gh(`/repos/${REPO}/contents/monitor-config.json`);
      const content = JSON.stringify({
        imacDailyTotal: total,
        note: 'Set from the hosted dashboard. The iMac monitor reads this each run; local config.json is the fallback.',
      }, null, 2) + '\n';
      await gh(`/repos/${REPO}/contents/monitor-config.json`, {
        method: 'PUT',
        body: JSON.stringify({
          message: `Set iMac checks per day to ${total} [skip ci]`,
          content: Buffer.from(content).toString('base64'),
          sha: cur.sha,
        }),
      });
      return res.status(200).json({ ok: true, target, total });
    }
    return res.status(400).json({ error: 'target must be github or imac' });
  } catch (e) {
    return res.status(502).json({ error: String(e.message).slice(0, 300) });
  }
}
