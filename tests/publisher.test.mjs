import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const source=await readFile(new URL('../scripts/publish-status.mjs',import.meta.url),'utf8');
async function run(failJobs=false) {
  let statusSaved, historyWrites=[];
  const today=new Date().toISOString().slice(0,10);
  const mock=async(url,init={})=>{
    let data={};
    if(url.includes('open-vsx.org')) data=url.includes('/cognispec')?{version:'2',downloadCount:17}:{version:'1',downloadCount:99};
    else if(url.includes('raw.githubusercontent')) data={imacDailyTotal:300,cognispecDailyTotal:1189};
    else if(url.includes('/workflows/')) data={workflow_runs:url.endsWith('page=1') ? Array.from({length:100},(_,i)=>({id:i,created_at:today+'T01:00:00Z'})) : [{id:100,created_at:today+'T00:00:00Z'}]};
    else if(url.includes('/jobs?')) { if(failJobs) return new Response('{}',{status:503}); data={jobs:[{name:'Clean install mock',conclusion:'success'}]}; }
    else if(url.includes('/git/ref/')) data={object:{sha:'fake'}};
    else if(url.includes('/contents/') && init.method!=='PUT') return new Response('{}',{status:404});
    else if(url.includes('/contents/') && init.method==='PUT') {
      const payload=JSON.parse(init.body), text=Buffer.from(payload.content,'base64').toString();
      if(url.includes('status.json')) statusSaved=JSON.parse(text); else historyWrites.push({url,text});
    }
    return new Response(JSON.stringify(data));
  };
  const ctx=vm.createContext({fetch:mock,process:{env:{GITHUB_TOKEN:'test',GITHUB_DAILY_TOTAL:'90'}},Buffer,AbortSignal,console:{log(){}}});
  await new vm.Script('(async()=>{'+source+'})()').runInContext(ctx);
  return {status:statusSaved,historyWrites};
}
test('publisher counts beyond both previous 12-job and 30-run caps',async()=>{
  const {status}=await run(); assert.equal(status.github.checksToday,101); assert.equal(status.github.runsToday,101); assert.equal(status.github.countsComplete,true);
});
test('publisher reports unknown, not zero, when counting fails',async()=>{
  const {status}=await run(true); assert.equal(status.github.checksToday,null); assert.equal(status.github.countsComplete,false);
});
test('publisher exposes both Open VSX counters and writes separate histories',async()=>{
  const {status,historyWrites}=await run();
  assert.deepEqual(status.extensions,{promptr:{version:'1',downloadCount:99},cognispec:{version:'2',downloadCount:17}});
  assert.deepEqual(status.openvsx,status.extensions.promptr);
  assert.deepEqual(status.imac,{dailyTotal:300,targets:{promptr:300,cognispec:1189}});
  assert.deepEqual(status.cognispec,{dailyTotal:1189});
  assert.equal(historyWrites.length,2);
  assert.ok(historyWrites.some(w=>w.url.includes('downloads.jsonl')&&!w.url.includes('cognispec'))&&historyWrites.some(w=>w.url.includes('downloads-cognispec.jsonl')));
  assert.match(historyWrites.find(w=>w.url.includes('downloads-cognispec'))?.text||'',/"extension":"cognispec"/);
});
