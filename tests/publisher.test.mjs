import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const source=await readFile(new URL('../scripts/publish-status.mjs',import.meta.url),'utf8');
async function run(failJobs=false) {
  let saved;
  const today=new Date().toISOString().slice(0,10);
  const mock=async(url,init={})=>{
    let data={};
    if(url.includes('open-vsx.org')) data={version:'1',downloadCount:99};
    else if(url.includes('raw.githubusercontent')) data={imacDailyTotal:300};
    else if(url.includes('/workflows/')) data={workflow_runs:url.endsWith('page=1') ? Array.from({length:100},(_,i)=>({id:i,created_at:today+'T01:00:00Z'})) : [{id:100,created_at:today+'T00:00:00Z'}]};
    else if(url.includes('/jobs?')) { if(failJobs) return new Response('{}',{status:503}); data={jobs:[{name:'Clean install mock',conclusion:'success'}]}; }
    else if(url.includes('/git/ref/')) data={object:{sha:'fake'}};
    else if(url.includes('/contents/') && init.method!=='PUT') return new Response('{}',{status:404});
    else if(url.includes('/contents/status.json') && init.method==='PUT') saved=JSON.parse(Buffer.from(JSON.parse(init.body).content,'base64').toString());
    return new Response(JSON.stringify(data));
  };
  const ctx=vm.createContext({fetch:mock,process:{env:{GITHUB_TOKEN:'test',GITHUB_DAILY_TOTAL:'90'}},Buffer,AbortSignal,console:{log(){}}});
  await new vm.Script('(async()=>{'+source+'})()').runInContext(ctx);
  return saved;
}
test('publisher counts beyond both previous 12-job and 30-run caps',async()=>{
  const s=await run(); assert.equal(s.github.checksToday,101); assert.equal(s.github.runsToday,101); assert.equal(s.github.countsComplete,true);
});
test('publisher reports unknown, not zero, when counting fails',async()=>{
  const s=await run(true); assert.equal(s.github.checksToday,null); assert.equal(s.github.countsComplete,false);
});
