import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as sleep} from 'node:timers/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {runCheckPipeline} from '../imac/check-pipeline.mjs';
import {prepareFreshRelay,removeJobRelay} from '../imac/fresh-relay.mjs';
import {reserveLocalPreparation,startPreparedLocalJob,reserveRemoteLease,applyFreshDownload} from '../imac/macbook-lease.mjs';
import {needsImmediateBatch} from '../imac/next-batch.mjs';
const now=Date.parse('2026-09-15T12:02:00Z');
const makeStores=()=>[{key:'promptr',id:'aryansudhir.promptr',total:6000,state:{jobs:Object.fromEntries(Array.from({length:10},(_,index)=>{const id='v2-20260915T1202-'+index;return [id,{id,index,slot:now,status:'pending'}];}))}}];
test('pipeline overlaps fresh preparation with tests while keeping all buffers bounded',async()=>{
 let preparing=0,testing=0,artifacts=0,maxPreparing=0,maxTesting=0,maxArtifacts=0;const completed=[];
 await runCheckPipeline({items:Array.from({length:12},(_,i)=>i),concurrency:3,maxReady:1,prepare:async i=>{maxPreparing=Math.max(maxPreparing,++preparing);await sleep(5);preparing--;maxArtifacts=Math.max(maxArtifacts,++artifacts);return {i};},execute:async x=>{maxTesting=Math.max(maxTesting,++testing);await sleep(120);testing--;artifacts--;completed.push(x.i);},discard:async()=>{artifacts--;}});
 assert.equal(maxPreparing,1);assert.equal(maxTesting,3);assert.ok(maxArtifacts<=5);assert.equal(artifacts,0);assert.equal(new Set(completed).size,12);
});
test('pipeline stops admission and discards prepared work after a fatal consumer error',async()=>{
 let acquired=0,disposed=0,executed=0;
 await assert.rejects(runCheckPipeline({items:[1,2,3,4,5],concurrency:1,maxReady:1,prepare:async i=>{acquired++;return {i};},execute:async()=>{executed++;await sleep(30);throw new Error('fixture failure');},discard:async()=>{disposed++;}}),/fixture failure/);
 assert.equal(executed,1);assert.equal(disposed,acquired);assert.ok(acquired<=3);
});
test('prepared ledger slots are separate from container slots and require verification',()=>{
 const stores=makeStores(),ids=Object.keys(stores[0].state.jobs);
 assert.equal(reserveLocalPreparation(stores,ids[0],{now}).reserved,true);
 assert.equal(reserveLocalPreparation(stores,ids[1],{now}).reserved,true);
 assert.equal(reserveLocalPreparation(stores,ids[2],{now}).reason,'prefetch_capacity');
 const j=stores[0].state.jobs[ids[0]];j.status='ready';assert.throws(()=>startPreparedLocalJob(stores,ids[0],{now}),/verified/);
 Object.assign(j,{artifactSha256:'a'.repeat(64),expectedVersion:'1.0',downloadEnd:new Date(now).toISOString()});
 assert.equal(startPreparedLocalJob(stores,ids[0],{now,activeLocalContainers:3}).reason,'capacity');
 assert.equal(startPreparedLocalJob(stores,ids[0],{now}).started,true);
 assert.equal(reserveLocalPreparation(stores,ids[2],{now}).reserved,true);
 assert.equal(reserveLocalPreparation(stores,ids[0],{now}).reason,'not_pending');
});
test('MacBook preparation cap bounds queued downloads without reducing its test lease cap',()=>{
 const stores=makeStores(),options={now,remoteLeaseCap:11,includeLocalActivity:false,maxPreparing:3};
 const leases=[];for(let i=0;i<3;i++)leases.push(reserveRemoteLease(stores,{...options,leaseToken:String(i).repeat(43)}));
 assert.throws(()=>reserveRemoteLease(stores,options),e=>e.code==='REMOTE_ACTIVE'&&/preparation/.test(e.message));
 applyFreshDownload(leases[0],{expectedVersion:'1.0',sha256:'a'.repeat(64),downloadStart:new Date(now).toISOString(),downloadEnd:new Date(now).toISOString(),bytes:10});
 assert.ok(reserveRemoteLease(stores,options));
});
test('every prepared job retrieves its own metadata, hash, and VSIX and retains its receipt after cleanup',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'fresh-relay-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));let calls=0;
 const bytes=Buffer.from('offline-only fixture'),hash=crypto.createHash('sha256').update(bytes).digest('hex'),metadata={version:'1.0',files:{sha256:'https://open-vsx.org/test.sha256',download:'https://open-vsx.org/test.vsix'}};
 const fetchFactory=options=>{assert.equal(options.clientClass,'imac');return async u=>{calls++;return new Response(u.endsWith('.sha256')?hash:u.endsWith('.vsix')?bytes:JSON.stringify(metadata));};};
 for(const id of ['first','second']){const r=await prepareFreshRelay({root,job:{id},store:{id:'aryansudhir.promptr'},variant:'manifest',fetchFactory,now:()=>now});const bundle=JSON.parse(fs.readFileSync(path.join(r.relayDir,'bundle.json')));assert.equal(bundle.jobId,id);assert.equal(bundle.sha256,hash);assert.equal(bundle.provenance.cache,false);removeJobRelay(root,id);assert.ok(fs.existsSync(path.join(root,'reports',id,'host-download.json')));assert.ok(!fs.existsSync(r.relayDir));}
 assert.equal(calls,6);
});
test('unverified bytes never produce a relay bundle or verified receipt',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'bad-relay-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const fetchFactory=()=>async u=>new Response(u.endsWith('/sha')?'a'.repeat(64):u.endsWith('/file')?'wrong bytes':JSON.stringify({version:'1',files:{sha256:'https://open-vsx.org/sha',download:'https://open-vsx.org/file'}}));
 await assert.rejects(prepareFreshRelay({root,job:{id:'bad'},store:{id:'aryansudhir.promptr'},variant:'manifest',fetchFactory}),/does not match/);
 assert.ok(!fs.existsSync(path.join(root,'reports','bad','host-download.json')));assert.ok(!fs.existsSync(path.join(root,'staging','bad','relay','bundle.json')));
});
test('scheduler promptly services due/pending jobs but never spins on blocked or stale status',()=>{
 const status={at:new Date(now+100).toISOString(),phase:'idle',targetDailyTotals:{promptr:6000}},states={promptr:{lastEnqueuedAt:now,jobs:{}}},input={status,states,runStartedAt:now,now:now+1000};
 assert.equal(needsImmediateBatch(input),false);
 assert.equal(needsImmediateBatch({...input,now:now+300000}),true);
 states.promptr.jobs.x={status:'pending'};assert.equal(needsImmediateBatch(input),true);
 assert.equal(needsImmediateBatch({...input,status:{...status,phase:'blocked'}}),false);
 assert.equal(needsImmediateBatch({...input,status:{...status,phase:'cooldown'}}),false);
 assert.equal(needsImmediateBatch({...input,runStartedAt:now+1000}),false);
});
