import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const helper=require.resolve('../imac/registry-fetch.cjs');
const {createRegistryFetch,initializeLimiter,readState,retryDelay,SPACING_MS,STREAM_COUNT,GLOBAL_START_SPACING_MS}=require(helper);
function assertFleetPacing(rows){
 assert.ok(rows.length>=1);
 const started=[...rows].sort((a,b)=>a.startedAt-b.startedAt);
 for(let i=1;i<started.length;i++)assert.ok(started[i].startedAt-started[i-1].startedAt>=GLOBAL_START_SPACING_MS);
 const byStream=new Map();
 for(const row of started){
  const previous=byStream.get(row.stream)||[];
  if(previous.length)assert.ok(row.startedAt>=previous[previous.length-1].finishedAt+SPACING_MS);
  previous.push(row);byStream.set(row.stream,previous);
 }
 let peak=0;
 for(const row of started){
  const live=started.filter(other=>other.startedAt<=row.startedAt&&other.finishedAt>row.startedAt).length;
  peak=Math.max(peak,live);
 }
 assert.ok(peak<=STREAM_COUNT);
}
function fixture(t){const dir=fs.mkdtempSync(path.join(process.env.QA_TEST_TMP||os.tmpdir(),'registry-test-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));initializeLimiter(dir,{containersAbsent:true});return dir;}
function state(dir,s){fs.writeFileSync(path.join(dir,'state.json'),JSON.stringify(s));}
const url='https://open-vsx.org/api/aryansudhir/promptr';
test('separate processes share one no-burst limiter',async t=>{
 const dir=fixture(t);const worker=`const{createRegistryFetch}=require(${JSON.stringify(helper)});(async()=>{const f=createRegistryFetch({stateDir:${JSON.stringify(dir)},reportDir:${JSON.stringify(dir)},runId:String(process.pid),fetchImpl:async()=>new Response('fresh')});for(let i=0;i<2;i++)await f(${JSON.stringify(url)});})().catch(e=>{console.error(e);process.exitCode=1})`;
 await Promise.all(Array.from({length:3},()=>new Promise((resolve,reject)=>{const c=spawn(process.execPath,['-e',worker]);let err='';c.stderr.on('data',d=>err+=d);c.on('error',reject);c.on('close',code=>code?reject(new Error(err)):resolve());})));
 const rows=fs.readFileSync(path.join(dir,'registry-requests.jsonl'),'utf8').trim().split('\n').map(JSON.parse).sort((a,b)=>a.startedAt-b.startedAt);
 assert.equal(rows.length,6);assert.equal(new Set(rows.map(r=>r.runId)).size,3);
 assertFleetPacing(rows);
});
// Regression guard for 2026-09-16: sending Cache-Control: no-cache forced every request past
// Fastly to the origin, which 503'd 5 of 8 paired probes against 1 of 8 without it. Each 503 arms
// a 30 s fleet-wide cooldown, so the header alone was enough to stall the fleet. Freshness is
// established by the SHA-256 check on the bytes, not by refusing the registry's own CDN.
test('requests do not force a cache bypass on the registry origin',async t=>{
 const dir=fixture(t);const seen=[];
 const f=createRegistryFetch({stateDir:dir,fetchImpl:async(_u,options)=>{seen.push(options?.headers);return new Response('fixture');}});
 await f(url);
 assert.equal(seen.length,1);
 const headers=new Headers(seen[0]||{});
 assert.equal(headers.get('cache-control'),null);
 assert.equal(headers.get('pragma'),null);
});
test('redirect requests are paced and final bytes are fresh',async t=>{
 const dir=fixture(t);let calls=0;
 const f=createRegistryFetch({stateDir:dir,reportDir:dir,fetchImpl:async u=>{calls++;return u.includes('eclipsecontent')?new Response('vsix'):new Response(null,{status:302,headers:{location:'https://openvsx.eclipsecontent.org/file.vsix'}});}});
 assert.equal(await (await f(url)).text(),'vsix');assert.equal(calls,2);
 const rows=fs.readFileSync(path.join(dir,'registry-requests.jsonl'),'utf8').trim().split('\n').map(JSON.parse);assertFleetPacing(rows);assert.ok(rows[1].startedAt-rows[0].startedAt>=GLOBAL_START_SPACING_MS);
});
test('429 cooldown applies to other callers and persists across restart',async t=>{
 const dir=fixture(t);let calls=0;
 const f=createRegistryFetch({stateDir:dir,totalTimeoutMs:1000,fetchImpl:async()=>{calls++;return new Response('',{status:429,headers:{'Retry-After':'120'}});}});
 await assert.rejects(f(url),e=>e.code==='REGISTRY_COOLDOWN');assert.equal(calls,1);
 const until=readState(dir).cooldownUntil;assert.ok(until>Date.now()+119000);
 initializeLimiter(dir,{containersAbsent:true});assert.equal(readState(dir).cooldownUntil,until);
 await assert.rejects(f(url),e=>e.code==='REGISTRY_COOLDOWN');assert.equal(calls,1);
});
test('short 429 is retried after cooldown; attempts stay bounded',async t=>{
 const dir=fixture(t);let calls=0;const times=[];
 const f=createRegistryFetch({stateDir:dir,fetchImpl:async()=>{times.push(Date.now());return ++calls===1?new Response('',{status:429,headers:{'retry-after':'0'}}):new Response('ok');}});
 assert.equal(await (await f(url)).text(),'ok');assert.equal(calls,2);assert.ok(times[1]-times[0]>=SPACING_MS+250);
 const g=createRegistryFetch({stateDir:dir,maxAttempts:2,fetchImpl:async()=>{calls++;return new Response('',{status:429,headers:{'retry-after':'0'}});}});
 assert.equal((await g(url)).status,429);assert.equal(calls,4);
});
test('Retry-After dates, missing values and long delays are handled conservatively',()=>{
 const now=Date.parse('2026-09-13T18:00:00Z');assert.equal(retryDelay('120',0,now,()=>0),120250);
 assert.equal(retryDelay('Sun, 13 Sep 2026 18:10:00 GMT',0,now,()=>0),600250);
 assert.equal(retryDelay(null,1,now,()=>0),4250);assert.equal(retryDelay('bad',0,now,()=>0),2250);
});
test('dead locks, corrupt state and unknown destinations fail closed',async t=>{
 const dir=fixture(t);let calls=0;const f=createRegistryFetch({stateDir:dir,totalTimeoutMs:80,fetchImpl:async()=>{calls++;return new Response('bad');}});
 for(let i=0;i<STREAM_COUNT;i++)fs.mkdirSync(path.join(dir,'lock-'+i));await assert.rejects(f(url),/lock deadline/);assert.equal(calls,0);
 assert.throws(()=>initializeLimiter(dir),/verify QA containers/);assert.ok(fs.existsSync(path.join(dir,'lock-0')));
 initializeLimiter(dir,{containersAbsent:true});state(dir,{version:1,nextAllowedAt:'bad',cooldownUntil:0});await assert.rejects(f(url),/Invalid registry/);assert.equal(calls,0);
 await assert.rejects(f('https://example.com/'),/Unexpected registry URL/);
});
test('network/body failures release the mutex but preserve spacing',async t=>{
 const dir=fixture(t);const f=createRegistryFetch({stateDir:dir,fetchImpl:async()=>{throw new Error('network down');}});
 await assert.rejects(f(url),/network down/);assert.equal(fs.existsSync(path.join(dir,'lock-0')),false);assert.equal(fs.existsSync(path.join(dir,'lock-1')),false);assert.ok(readState(dir).streams.some(s=>s.nextAllowedAt>Date.now()));
});
test('host integration verifies cleanup and routes all harness requests through the limiter',()=>{
 const monitor=fs.readFileSync(new URL('../imac/monitor.mjs',import.meta.url),'utf8');
 assert.ok(monitor.indexOf("['ps','-a','--format'")<monitor.indexOf('await prepareSharedLimiter('));
 assert.match(monitor,/REGISTRY_LIMIT_DIR=\/opt\/check\/registry-limit/);
 for(const f of ['registry-fetch.cjs','container-check.cjs'])assert.ok(monitor.includes(`:/opt/check/${f}:ro`));
 assert.match(monitor,/cooldownUntil>Date\.now\(\)/);
 const harness=fs.readFileSync(new URL('../imac/container-check.cjs',import.meta.url),'utf8');assert.match(harness,/await registryFetch\(url\)/);assert.doesNotMatch(harness,/await fetch\(/);
});
test('a stalled response body stays inside the request timeout',async t=>{
 const {createServer}=await import('node:http');const dir=fixture(t);
 const server=createServer((req,res)=>{res.writeHead(200);res.write('partial');});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(()=>{server.closeAllConnections();server.close();});
 const f=createRegistryFetch({stateDir:dir,requestTimeoutMs:100,fetchImpl:(_u,options)=>fetch(`http://127.0.0.1:${server.address().port}`,options)});
 await assert.rejects(f(url),e=>/abort|timeout/i.test(e.name+' '+e.message));
 assert.equal(fs.existsSync(path.join(dir,'lock-0')),false);assert.equal(fs.existsSync(path.join(dir,'lock-1')),false);assert.ok(readState(dir).streams.some(s=>s.nextAllowedAt>Date.now()));
});

test('fair queue serves waiting clients before a client reacquires',async t=>{
 const dir=fixture(t),order=[];
 const runs=Array.from({length:6},(_,i)=>{const f=createRegistryFetch({stateDir:dir,runId:String(i),fetchImpl:async()=>{order.push(i);return new Response('offline fixture');}});return (async()=>{await f(url);await f(url);})();});
 await Promise.all(runs);assert.equal(order.length,12);assert.equal(new Set(order.slice(0,6)).size,6);
 assert.equal(fs.readdirSync(path.join(dir,'queue')).length,0);
});
test('an owner cannot remove a replacement registry lock',async t=>{
 const dir=fixture(t); const f=createRegistryFetch({stateDir:dir,fetchImpl:async()=>{
  const stream=fs.existsSync(path.join(dir,'lock-0','owner.json'))?0:1;
  fs.writeFileSync(path.join(dir,'lock-'+stream,'owner.json'),JSON.stringify({token:'replacement',runId:'other'}));return new Response('fixture');
 }});
 await assert.rejects(f(url),/ownership changed/);
 const owner=fs.existsSync(path.join(dir,'lock-0','owner.json'))?path.join(dir,'lock-0','owner.json'):path.join(dir,'lock-1','owner.json');
 assert.equal(JSON.parse(fs.readFileSync(owner)).token,'replacement');
});
test('relay overall deadline bounds the whole multi-request sequence',async t=>{
 const dir=fixture(t);let calls=0;
 const f=createRegistryFetch({stateDir:dir,overallDeadline:Date.now()+900,totalTimeoutMs:30000,fetchImpl:async()=>{calls++;return new Response('fixture');}});
 await f(url);await assert.rejects(f(url),/deadline/);assert.equal(calls,1);
});

test('MacBook priority is three turns to one while unused capacity remains available to either runner',()=>{
 const {chooseRegistryTicket}=require(helper);
 const waiting=[{name:'m1',clientClass:'macbook'},{name:'i1',clientClass:'imac'},{name:'m2',clientClass:'macbook'},{name:'i2',clientClass:'imac'}];
 assert.deepEqual([0,1,2,3].map(turn=>chooseRegistryTicket(waiting,turn).clientClass),['macbook','macbook','macbook','imac']);
 assert.equal(chooseRegistryTicket(waiting.filter(x=>x.clientClass==='macbook'),3).name,'m1');
 assert.equal(chooseRegistryTicket(waiting.filter(x=>x.clientClass==='imac'),0).name,'i1');
 assert.equal(chooseRegistryTicket([],0),null);
});
test('weighted callers preserve spacing and complete without starvation',async t=>{
 const dir=fixture(t),order=[];
 const make=clientClass=>createRegistryFetch({stateDir:dir,clientClass,reportDir:dir,fetchImpl:async()=>{order.push(clientClass);return new Response('offline');}});
 const imac=make('imac'),macbook=make('macbook');
 await Promise.all([(async()=>{for(let i=0;i<6;i++)await imac(url);})(),(async()=>{for(let i=0;i<2;i++)await macbook(url);})()]);
 assert.equal(order.filter(x=>x==='imac').length,6);assert.equal(order.filter(x=>x==='macbook').length,2);
 const rows=fs.readFileSync(path.join(dir,'registry-requests.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
 assertFleetPacing(rows);
});
test('two streams can overlap slow bodies while starts stay at 2.5 rps',async t=>{
 const dir=fixture(t);const f=createRegistryFetch({stateDir:dir,reportDir:dir,fetchImpl:async()=>{await new Promise(r=>setTimeout(r,500));return new Response('slow');}});
 await Promise.all(Array.from({length:4},()=>f(url)));
 const rows=fs.readFileSync(path.join(dir,'registry-requests.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
 assert.equal(new Set(rows.map(row=>row.stream)).size,STREAM_COUNT);assertFleetPacing(rows);
});
test('overlapping processes persist stream state without clobbering the temp file',async t=>{
 const dir=fixture(t);
 const worker=`const fs=require('node:fs');const {setTimeout:sleep}=require('node:timers/promises');const {createRegistryFetch}=require(${JSON.stringify(helper)});(async()=>{const f=createRegistryFetch({stateDir:${JSON.stringify(dir)},reportDir:${JSON.stringify(dir)},runId:String(process.pid),fetchImpl:async()=>{const ready=${JSON.stringify(path.join(dir,'ready.'))}+process.pid;fs.writeFileSync(ready,'1');const start=Date.now();while(fs.readdirSync(${JSON.stringify(dir)}).filter(n=>n.startsWith('ready.')).length<2){if(Date.now()-start>5000)throw new Error('ready gate');await sleep(10);}return new Response('together');}});await f(${JSON.stringify(url)});})().catch(e=>{console.error(e);process.exitCode=1})`;
 await Promise.all(Array.from({length:2},()=>new Promise((resolve,reject)=>{const c=spawn(process.execPath,['-e',worker]);let err='';c.stderr.on('data',d=>err+=d);c.on('error',reject);c.on('close',code=>code?reject(new Error(err||'exit '+code)):resolve());})));
 const rows=fs.readFileSync(path.join(dir,'registry-requests.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
 assert.equal(rows.length,2);assertFleetPacing(rows);
 const state=readState(dir);assert.equal(state.streams.length,STREAM_COUNT);assert.ok(state.streams.every(s=>Number.isFinite(s.nextAllowedAt)));
});
