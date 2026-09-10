import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const source = await readFile(new URL('../api/settings.js', import.meta.url), 'utf8');
const { default: handler } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
process.env.GH_TOKEN = 'test-only'; process.env.DASH_KEY = 'test-key';
async function invoke(method, body, extra = {}) {
  const r = { headers: {}, setHeader(k,v) { this.headers[k]=v; }, status(s) { this.code=s; return this; },
    json(b) { this.body=b; return this; }, end() { return this; } };
  await handler({ method, body, headers: { 'x-dash-key': 'test-key', ...extra } }, r); return r;
}
test('reject unauthenticated, foreign origin and unsupported methods', async () => {
  globalThis.fetch = () => { throw new Error('must not contact GitHub'); };
  assert.equal((await invoke('POST', {}, { 'x-dash-key': '' })).code,401);
  assert.equal((await invoke('POST', {}, { origin: 'https://evil.example' })).code,403);
  assert.equal((await invoke('DELETE')).code,405);
  const pre = await invoke('OPTIONS', null, { origin: 'https://aryansudhirdev.github.io' });
  assert.equal(pre.code,204); assert.equal(pre.headers['Access-Control-Allow-Origin'],'https://aryansudhirdev.github.io');
});
test('strict validation rejects coercions and malformed JSON', async () => {
  for (const total of [0,8001,1.4,true,'200',null]) assert.equal((await invoke('POST',{target:'imac',total})).code,400);
  assert.equal((await invoke('POST','{')).code,400);
  assert.equal((await invoke('POST',{target:'other',total:200})).code,400);
});
test('GET returns authoritative settings without credentials and disables caching', async () => {
  globalThis.fetch = async url => new Response(JSON.stringify(url.includes('/variables/') ? {value:'80'} :
    {content:Buffer.from(JSON.stringify({imacDailyTotal:300})).toString('base64')}));
  const r=await invoke('GET'); assert.deepEqual(r.body.settings,{github:80,imac:300});
  assert.equal(r.headers['Cache-Control'],'no-store'); assert.ok(!JSON.stringify(r.body).includes('test-key'));
});
test('config update preserves fields and retries a conflict', async () => {
  let writes=0;
  globalThis.fetch = async (url,init) => {
    if(init.method==='PUT') {
      writes++; const payload=JSON.parse(init.body);
      assert.deepEqual(JSON.parse(Buffer.from(payload.content,'base64').toString()),{imacDailyTotal:200,custom:'keep'});
      return writes===1 ? new Response('{}',{status:409}) : new Response('{}');
    }
    return new Response(JSON.stringify({sha:'sha',content:Buffer.from(JSON.stringify({imacDailyTotal:300,custom:'keep'})).toString('base64')}));
  };
  assert.equal((await invoke('POST',{target:'imac',total:200})).code,200); assert.equal(writes,2);
});
test('GitHub errors never expose raw response or credentials', async () => {
  globalThis.fetch=async()=>new Response('sensitive upstream detail',{status:403});
  const r=await invoke('POST',{target:'github',total:80}); assert.equal(r.code,502);
  assert.ok(!JSON.stringify(r.body).includes('sensitive'));
});

test('iMac supports 8000 but GitHub retains its 1000 ceiling',async()=>{
  globalThis.fetch=async(url,init)=>new Response(JSON.stringify({sha:'test',content:Buffer.from(JSON.stringify({imacDailyTotal:8000})).toString('base64')}));
  assert.equal((await invoke('POST',{target:'imac',total:8000})).code,200);
  assert.equal((await invoke('POST',{target:'github',total:1001})).code,400);
  assert.equal((await invoke('POST',{target:'imac',total:8001})).code,400);
});
