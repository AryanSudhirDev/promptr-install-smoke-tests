import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
 MAX_MACBOOK_WORKERS,macbookContainerName,poolStatusSnapshot,runWorkerLanes,
} from '../macbook/worker.mjs';

test('MacBook worker starts exactly three concurrent lanes',async()=>{
 assert.equal(MAX_MACBOOK_WORKERS,3);
 let active=0,peak=0,release;
 const allStarted=new Promise(resolve=>{release=resolve;});
 const seen=[];
 const results=await runWorkerLanes(async lane=>{
  seen.push(lane);active++;peak=Math.max(peak,active);
  if(active===MAX_MACBOOK_WORKERS)release();
  await allStarted;active--;return lane;
 });
 assert.equal(peak,3);assert.deepEqual(seen.sort((a,b)=>a-b),[1,2,3]);assert.deepEqual(results,[1,2,3]);
});

test('pool waits for every lane to settle before surfacing a lane failure',async()=>{
 const settled=[];let failures=0;
 await assert.rejects(runWorkerLanes(async lane=>{
  if(lane===1)throw new Error('lane failed');
  await new Promise(resolve=>setTimeout(resolve,10));settled.push(lane);
 },{onFailure:()=>{failures++;}}),/lane failed/);
 assert.deepEqual(settled.sort((a,b)=>a-b),[2,3]);assert.equal(failures,1);
});

test('lane status reports active count without exposing lease tokens',()=>{
 const active=new Map([
  [2,{jobId:'job-2',target:'promptr',variant:'stable',leaseToken:'secret-token'}],
  [1,{jobId:'job-1',target:'cognispec',variant:'insiders',leaseToken:'other-secret'}],
 ]);
 const status=poolStatusSnapshot(active,{phase:'waiting_for_work',detail:'fixture',leaseToken:'third-secret'});
 assert.equal(status.phase,'running_check');assert.equal(status.activeCount,2);
 assert.deepEqual(status.activeChecks,[
  {lane:1,jobId:'job-1',target:'cognispec',variant:'insiders'},
  {lane:2,jobId:'job-2',target:'promptr',variant:'stable'},
 ]);
 assert.equal(JSON.stringify(status).includes('secret'),false);assert.equal('leaseToken' in status,false);
});

test('container names are job-local and reject unsafe identities',()=>{
 assert.equal(macbookContainerName('macbook-v2-20260915T0100-2'),'macbook-check-macbook-v2-20260915T0100-2');
 for(const bad of ['', '../other', 'job with spaces', 'x'.repeat(161)])assert.throws(()=>macbookContainerName(bad),/Invalid leased job identity/);
});

test('normal checks clean only their lane container while recovery and final abort retain global cleanup',()=>{
 const source=fs.readFileSync(new URL('../macbook/worker.mjs',import.meta.url),'utf8');
 const checkSource=source.slice(source.indexOf('async function check('),source.indexOf('function prune()'));
 const recoverSource=source.slice(source.indexOf('async function recover()'),source.indexOf('function readReports('));
 const mainSource=source.slice(source.indexOf('async function main()'),source.indexOf('const invokedPath='));
 assert.match(checkSource,/cleanupContainer\(activeName\)/);assert.doesNotMatch(checkSource,/cleanupAll\(/);
 assert.match(recoverSource,/await cleanupAll\(\)/);assert.match(mainSource,/finally\{[\s\S]*await cleanupAll\(\)/);
 assert.match(mainSource,/worker\.pid/);assert.match(mainSource,/acquireLocalLock/);
});
