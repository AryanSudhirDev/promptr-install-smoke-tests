import test from 'node:test';import assert from 'node:assert/strict';
import {advanceTarget,selectJobs} from '../imac/multi-plan.mjs';
import {initialState,SLOT_MS} from '../imac/schedule.mjs';
const start=Date.parse('2026-09-14T00:02:00Z');
test('two independent exact daily totals and noncolliding report IDs',()=>{
 let p=initialState(start-SLOT_MS,1400),c=initialState(start-SLOT_MS,1189);
 for(let i=0;i<288;i++){p=advanceTarget(p,start+i*SLOT_MS,'promptr',1400);c=advanceTarget(c,start+i*SLOT_MS,'cognispec',1189);for(const j of [...Object.values(p.jobs),...Object.values(c.jobs)])if(j.status==='pending')j.status='passed';}
 assert.equal(Object.keys(p.jobs).length,1400);assert.equal(Object.keys(c.jobs).length,1189);
 assert.equal(new Set([...Object.keys(p.jobs),...Object.keys(c.jobs)]).size,2589);
 assert.ok(Object.values(c.jobs).every(j=>j.target==='cognispec'&&j.id.startsWith('cognispec-v2-')));
});
test('adding Cognispec does not alter Promptr IDs or replay history',()=>{
 let p=initialState(start,1400);p=advanceTarget(p,start+SLOT_MS,'promptr',1400);const ids=Object.keys(p.jobs);
 const c=advanceTarget(null,start+SLOT_MS,'cognispec',1189);assert.ok(Object.values(c.jobs).every(j=>j.slot===start+SLOT_MS));
 const queue=selectJobs([{key:'promptr',total:1400,state:p},{key:'cognispec',total:1189,state:c}],3);
 assert.equal(queue.length,3);assert.equal(new Set(queue.map(q=>q.store.key)).size,2);assert.deepEqual(Object.keys(p.jobs),ids);
 assert.equal(selectJobs([{key:'promptr',total:1400,state:p},{key:'cognispec',total:1189,state:c}],100).length,Object.keys(p.jobs).length+Object.keys(c.jobs).length);
});
test('disabled target does not replay disabled slots on reenable',()=>{
 let c=advanceTarget(null,start,'cognispec',1189);c=advanceTarget(c,start+SLOT_MS*10,'cognispec',0);assert.equal(Object.values(c.jobs).filter(j=>j.status==='pending').length,0);
 c=advanceTarget(c,start+SLOT_MS*11,'cognispec',1189);assert.ok(Object.values(c.jobs).filter(j=>j.status==='pending').every(j=>j.slot===start+SLOT_MS*11));
});
test('disk guard pauses below five GiB without guessing on invalid values',async()=>{
 const {diskAllowsStart}=await import('../imac/multi-plan.mjs');assert.equal(diskAllowsStart({bavail:4,bsize:1024**3}),false);assert.equal(diskAllowsStart({bavail:5,bsize:1024**3}),true);assert.equal(diskAllowsStart({bavail:8,bsize:1024**3}),true);assert.equal(diskAllowsStart({bavail:NaN,bsize:4096}),false);
});
