import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const helper=require.resolve('../imac/registry-fetch.cjs');
const {createRegistryFetch,initializeLimiter,readState,retryDelay,SPACING_MS}=require(helper);
function fixture(t){const dir=fs.mkdtempSync(path.join(process.env.QA_TEST_TMP||os.tmpdir(),'registry-test-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));initializeLimiter(dir,{containersAbsent:true});return dir;}
function state(dir,s){fs.writeFileSync(path.join(dir,'state.json'),JSON.stringify(s));}
const url='https://open-vsx.org/api/aryansudhir/promptr';
test('separate processes share one no-burst limiter',async t=>{
 const dir=fixture(t);const worker=`const{createRegistryFetch}=require(${JSON.stringify(helper)});(async()=>{const f=createRegistryFetch({stateDir:${JSON.stringify(dir)},reportDir:${JSON.stringify(dir)},runId:String(process.pid),fetchImpl:async()=>new Response('fresh')});for(let i=0;i<2;i++)await f(${JSON.stringify(url)});})().catch(e=>{console.error(e);process.exitCode=1})`;
 await Promise.all(Array.from({length:3},()=>new Promise((resolve,reject)=>{const c=spawn(process.execPath,['-e',worker]);let err='';c.stderr.on('data',d=>err+=d);c.on('error',reject);c.on('close',code=>code?reject(new Error(err)):resolve());})));
 const rows=fs.readFileSync(path.join(dir,'registry-requests.jsonl'),'utf8').trim().split('\n').map(JSON.parse).sort((a,b)=>a.startedAt-b.startedAt);
 assert.equal(rows.length,6);assert.equal(new Set(rows.map(r=>r.runId)).size,3);
 for(let i=1;i<rows.length;i++)assert.ok(rows[i].startedAt-rows[i-1].finishedAt>=SPACING_MS);
});
test('redirect requests are paced and final bytes are fresh',async t=>{
 const dir=fixture(t);let calls=0;
 const f=createRegistryFetch({stateDir:dir,reportDir:dir,fetchImpl:async u=>{calls++;return u.includes('eclipsecontent')?new Response('vsix'):new Response(null,{status:302,headers:{location:'https://openvsx.eclipsecontent.org/file.vsix'}});}});
 assert.equal(await (await f(url)).text(),'vsix');assert.equal(calls,2);
 const rows=fs.readFileSync(path.join(dir,'registry-requests.jsonl'),'utf8').trim().split('\n').map(JSON.parse);assert.ok(rows[1].startedAt-rows[0].finishedAt>=SPACING_MS);
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
 fs.mkdirSync(path.join(dir,'lock'));await assert.rejects(f(url),/lock deadline/);assert.equal(calls,0);
 assert.throws(()=>initializeLimiter(dir),/verify QA containers/);assert.ok(fs.existsSync(path.join(dir,'lock')));
 initializeLimiter(dir,{containersAbsent:true});state(dir,{version:1,nextAllowedAt:'bad',cooldownUntil:0});await assert.rejects(f(url),/Invalid registry/);assert.equal(calls,0);
 await assert.rejects(f('https://example.com/'),/Unexpected registry URL/);
});
test('network/body failures release the mutex but preserve spacing',async t=>{
 const dir=fixture(t);const f=createRegistryFetch({stateDir:dir,fetchImpl:async()=>{throw new Error('network down');}});
 await assert.rejects(f(url),/network down/);assert.equal(fs.existsSync(path.join(dir,'lock')),false);assert.ok(readState(dir).nextAllowedAt>Date.now());
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
 assert.equal(fs.existsSync(path.join(dir,'lock')),false);assert.ok(readState(dir).nextAllowedAt>Date.now());
});

test('fair queue serves waiting clients before a client reacquires',async t=>{
 const dir=fixture(t),order=[];
 const runs=Array.from({length:6},(_,i)=>{const f=createRegistryFetch({stateDir:dir,runId:String(i),fetchImpl:async()=>{order.push(i);return new Response('offline fixture');}});return (async()=>{await f(url);await f(url);})();});
 await Promise.all(runs);assert.equal(order.length,12);assert.equal(new Set(order.slice(0,6)).size,6);
 assert.equal(fs.readdirSync(path.join(dir,'queue')).length,0);
});
test('an owner cannot remove a replacement registry lock',async t=>{
 const dir=fixture(t);const f=createRegistryFetch({stateDir:dir,fetchImpl:async()=>{
  fs.writeFileSync(path.join(dir,'lock','owner.json'),JSON.stringify({token:'replacement',runId:'other'}));return new Response('fixture');
 }});
 await assert.rejects(f(url),/ownership changed/);
 assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'lock','owner.json'))).token,'replacement');
});
test('relay overall deadline bounds the whole multi-request sequence',async t=>{
 const dir=fixture(t);let calls=0;
 const f=createRegistryFetch({stateDir:dir,overallDeadline:Date.now()+900,totalTimeoutMs:30000,fetchImpl:async()=>{calls++;return new Response('fixture');}});
 await f(url);await assert.rejects(f(url),/deadline/);assert.equal(calls,1);
});

test('iMac priority is three turns to one while unused capacity remains available to either runner',()=>{
 const {chooseRegistryTicket}=require(helper);
 const waiting=[{name:'m1',clientClass:'macbook'},{name:'i1',clientClass:'imac'},{name:'m2',clientClass:'macbook'},{name:'i2',clientClass:'imac'}];
 assert.deepEqual([0,1,2,3].map(turn=>chooseRegistryTicket(waiting,turn).clientClass),['imac','imac','imac','macbook']);
 assert.equal(chooseRegistryTicket(waiting.filter(x=>x.clientClass==='macbook'),0).name,'m1');
 assert.equal(chooseRegistryTicket(waiting.filter(x=>x.clientClass==='imac'),3).name,'i1');
 assert.equal(chooseRegistryTicket([],0),null);
});
test('weighted callers preserve spacing and complete without starvation',async t=>{
 const dir=fixture(t),order=[];
 const make=clientClass=>createRegistryFetch({stateDir:dir,clientClass,reportDir:dir,fetchImpl:async()=>{order.push(clientClass);return new Response('offline');}});
 const imac=make('imac'),macbook=make('macbook');
 await Promise.all([(async()=>{for(let i=0;i<6;i++)await imac(url);})(),(async()=>{for(let i=0;i<2;i++)await macbook(url);})()]);
 assert.deepEqual(order,['imac','imac','imac','macbook','imac','imac','imac','macbook']);
 const rows=fs.readFileSync(path.join(dir,'registry-requests.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
 for(let i=1;i<rows.length;i++)assert.ok(rows[i].startedAt-rows[i-1].finishedAt>=650);
});
