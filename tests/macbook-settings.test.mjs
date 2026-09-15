import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const source = await readFile(new URL('../api/macbook.js', import.meta.url), 'utf8');
const { default: handler } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
process.env.GH_TOKEN = 'test-only'; process.env.DASH_KEY = 'test-key';
const DEFAULTS = { enabled: true, minBatteryPercent: 50, pollIntervalMinutes: 10, requireAC: true, requireHome: true, promptrDailyTotal: 3000, cognispecDailyTotal: 2000 };
async function invoke(method, body, extra = {}) {
  const r = { headers: {}, setHeader(k,v) { this.headers[k]=v; }, status(s) { this.code=s; return this; },
    json(b) { this.body=b; return this; }, end() { return this; } };
  await handler({ method, body, headers: { 'x-dash-key': 'test-key', ...extra } }, r); return r;
}

test('reject unauthenticated, foreign origin and unsupported methods', async () => {
  globalThis.fetch = () => { throw new Error('must not contact GitHub'); };
  assert.equal((await invoke('POST', { settings: DEFAULTS }, { 'x-dash-key': '' })).code, 401);
  assert.equal((await invoke('POST', { settings: DEFAULTS }, { origin: 'https://evil.example' })).code, 403);
  assert.equal((await invoke('DELETE')).code, 405);
  const pre = await invoke('OPTIONS', null, { origin: 'https://aryansudhirdev.github.io' });
  assert.equal(pre.code, 204);
  assert.equal(pre.headers['Access-Control-Allow-Origin'], 'https://aryansudhirdev.github.io');
});

test('strict validation rejects wrong types, out-of-range values, and extra/missing fields', async () => {
  globalThis.fetch = () => { throw new Error('must not contact GitHub'); };
  const bad = [
    { ...DEFAULTS, enabled: 'true' }, { ...DEFAULTS, enabled: 1 }, { ...DEFAULTS, enabled: null },
    { ...DEFAULTS, minBatteryPercent: 9 }, { ...DEFAULTS, minBatteryPercent: 96 },
    { ...DEFAULTS, minBatteryPercent: 50.5 }, { ...DEFAULTS, minBatteryPercent: '50' }, { ...DEFAULTS, minBatteryPercent: true },
    { ...DEFAULTS, pollIntervalMinutes: 0 }, { ...DEFAULTS, pollIntervalMinutes: 61 },
    { ...DEFAULTS, pollIntervalMinutes: 5.5 }, { ...DEFAULTS, pollIntervalMinutes: '10' },
    { ...DEFAULTS, requireAC: 'yes' }, { ...DEFAULTS, requireHome: 0 },
    { ...DEFAULTS, extraField: true }, { enabled: true }, { enabled: true, minBatteryPercent: 50 },
    [], 'not-an-object', null, 42,
  ];
  for (const settings of bad) assert.equal((await invoke('POST', { settings })).code, 400, JSON.stringify(settings));
  assert.equal((await invoke('POST', '{')).code, 400);
  assert.equal((await invoke('POST', { settings: DEFAULTS, other: 1 })).code, 400);
  assert.equal((await invoke('POST', [DEFAULTS])).code, 400);
  assert.equal((await invoke('POST', DEFAULTS)).code, 400);
});

test('accepts inclusive boundary values', async () => {
  globalThis.fetch = async (url, init) => init?.method === 'PUT'
    ? new Response('{}')
    : new Response(JSON.stringify({ sha: 's', content: Buffer.from(JSON.stringify(DEFAULTS)).toString('base64') }));
  for (const settings of [
    { ...DEFAULTS, minBatteryPercent: 10, pollIntervalMinutes: 1 },
    { ...DEFAULTS, minBatteryPercent: 95, pollIntervalMinutes: 60 },
  ]) {
    const r = await invoke('POST', { settings });
    assert.equal(r.code, 200);
    assert.deepEqual(r.body.settings, settings);
  }
});

test('GET returns writable/repo/settings without leaking credentials and disables caching', async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ content: Buffer.from(JSON.stringify(DEFAULTS)).toString('base64') }));
  const r = await invoke('GET');
  assert.deepEqual(r.body.settings, DEFAULTS);
  assert.equal(r.body.writable, true);
  assert.equal(r.body.repo, 'AryanSudhirDev/promptr-install-smoke-tests');
  assert.equal(r.headers['Cache-Control'], 'no-store');
  const dump = JSON.stringify(r.body);
  assert.ok(!dump.includes('test-key'));
  assert.ok(!dump.includes('test-only'));
});

test('GET returns null settings when the read fails or the stored config is invalid', async () => {
  globalThis.fetch = async () => { throw new Error('network down'); };
  assert.equal((await invoke('GET')).body.settings, null);
  globalThis.fetch = async () => new Response(JSON.stringify({ content: Buffer.from(JSON.stringify({ enabled: true })).toString('base64') }));
  assert.equal((await invoke('GET')).body.settings, null);
});

test('write preserves unrelated fields and retries a 409 conflict exactly once', async () => {
  let writes = 0;
  globalThis.fetch = async (url, init) => {
    if (init?.method === 'PUT') {
      writes++;
      const payload = JSON.parse(init.body);
      const saved = JSON.parse(Buffer.from(payload.content, 'base64').toString());
      assert.equal(saved.futureField, 'keep');
      assert.deepEqual(
        { enabled: saved.enabled, minBatteryPercent: saved.minBatteryPercent, pollIntervalMinutes: saved.pollIntervalMinutes, requireAC: saved.requireAC, requireHome: saved.requireHome, promptrDailyTotal:saved.promptrDailyTotal, cognispecDailyTotal:saved.cognispecDailyTotal },
        { ...DEFAULTS, pollIntervalMinutes: 20 },
      );
      return writes === 1 ? new Response('{}', { status: 409 }) : new Response('{}');
    }
    return new Response(JSON.stringify({ sha: 'sha', content: Buffer.from(JSON.stringify({ ...DEFAULTS, futureField: 'keep' })).toString('base64') }));
  };
  const r = await invoke('POST', { settings: { ...DEFAULTS, pollIntervalMinutes: 20 } });
  assert.equal(r.code, 200);
  assert.equal(writes, 2);
  assert.deepEqual(r.body.settings, { ...DEFAULTS, pollIntervalMinutes: 20 });
});

test('a conflict that persists past the retry surfaces as 409, not a silent partial write', async () => {
  globalThis.fetch = async (url, init) => init?.method === 'PUT'
    ? new Response('{}', { status: 409 })
    : new Response(JSON.stringify({ sha: 'sha', content: Buffer.from(JSON.stringify(DEFAULTS)).toString('base64') }));
  const r = await invoke('POST', { settings: { ...DEFAULTS, pollIntervalMinutes: 15 } });
  assert.equal(r.code, 409);
});

test('GitHub errors never expose raw response text or credentials', async () => {
  globalThis.fetch = async () => new Response('sensitive upstream detail', { status: 403 });
  const r = await invoke('POST', { settings: DEFAULTS });
  assert.equal(r.code, 502);
  const dump = JSON.stringify(r.body);
  assert.ok(!dump.includes('sensitive'));
  assert.ok(!dump.includes('test-only'));
  assert.ok(!dump.includes('test-key'));
});

test('OPTIONS never requires a key and rejects disallowed origins even for preflight', async () => {
  globalThis.fetch = () => { throw new Error('must not contact GitHub'); };
  const rejected = await invoke('OPTIONS', null, { origin: 'https://evil.example' });
  assert.equal(rejected.code, 403);
});

test('unchanged saves avoid empty commits and malformed stored configuration is not overwritten', async () => {
  let writes=0;
  globalThis.fetch=async(url,init)=>{if(init.method==='PUT')writes++;return new Response(JSON.stringify({sha:'fixture',content:Buffer.from(JSON.stringify(DEFAULTS)).toString('base64')}));};
  assert.equal((await invoke('POST',{settings:DEFAULTS})).code,200);assert.equal(writes,0);
  globalThis.fetch=async(url,init)=>{if(init.method==='PUT')writes++;return new Response(JSON.stringify({sha:'fixture',content:Buffer.from('{invalid').toString('base64')}));};
  assert.equal((await invoke('POST',{settings:DEFAULTS})).code,502);assert.equal(writes,0);
});

test('MacBook daily target caps accept reductions and reject increases',async()=>{
 for(const settings of [{...DEFAULTS,promptrDailyTotal:0,cognispecDailyTotal:0},{...DEFAULTS,promptrDailyTotal:3000,cognispecDailyTotal:2000}]){
  globalThis.fetch=async()=>new Response(JSON.stringify({sha:'fixture',content:Buffer.from(JSON.stringify(settings)).toString('base64')}));assert.equal((await invoke('POST',{settings})).code,200);
 }
 for(const settings of [{...DEFAULTS,promptrDailyTotal:3001},{...DEFAULTS,cognispecDailyTotal:2001},{...DEFAULTS,promptrDailyTotal:-1},{...DEFAULTS,cognispecDailyTotal:1.5}]){globalThis.fetch=()=>{throw new Error('must not call');};assert.equal((await invoke('POST',{settings})).code,400);}
});
