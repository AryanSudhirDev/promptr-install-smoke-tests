import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
 GLOBAL_CHECK_CAP,LEASE_MS,LeaseError,acquirePidLock,activeRemoteLeases,expireRemoteLeases,
 remoteCapacity,reserveLocalJob,reserveRemoteLease,
} from '../imac/macbook-lease.mjs';
import {claimOperation,peekOperation} from '../imac/macbook-broker.mjs';

const now=Date.parse('2026-09-14T20:02:00Z'),token='p'.repeat(43);
const job=(id,index,status='pending',extra={})=>({id,slot:now,index,plannedTotal:1400,status,target:'promptr',...extra});
function storesFor(jobs){
 return [
  {key:'promptr',id:'aryansudhir.promptr',total:1400,state:{version:2,dailyTotal:1400,lastEnqueuedAt:now,jobs:Object.fromEntries(jobs.map(item=>[item.id,item])),missedSlots:0}},
  {key:'cognispec',id:'aryansudhir.cognispec',total:0,state:null},
 ];
}
function fixture(t,jobs){
 const root=fs.mkdtempSync(path.join(process.env.QA_TEST_TMP||os.tmpdir(),'parallel-fleet-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 fs.writeFileSync(path.join(root,'config.json'),JSON.stringify({dailyTotal:1400,cognispecDailyTotal:0}));
 fs.writeFileSync(path.join(root,'scheduler-v2.json'),JSON.stringify(storesFor(jobs)[0].state));
 fs.mkdirSync(path.join(root,'registry-limit'));fs.writeFileSync(path.join(root,'registry-limit','state.json'),JSON.stringify({version:1,nextAllowedAt:0,cooldownUntil:0}));
 return root;
}

test('MacBook claim coexists with one or two iMac checks and rejects only a full fleet',()=>{
 for(const localCount of [1,2]){
  const jobs=Array.from({length:localCount},(_,index)=>job(`v2-20260914T2002-${index}`,index,'started'));
  jobs.push(job(`v2-20260914T2002-${localCount}`,localCount));
  const stores=storesFor(jobs),claim=reserveRemoteLease(stores,{now,activeLocalContainers:localCount,leaseToken:token});
  assert.equal(claim.job.status,'remote_started');
  assert.deepEqual(remoteCapacity(stores,{activeLocalContainers:localCount}),{remote:1,local:localCount,total:localCount+1,remaining:GLOBAL_CHECK_CAP-localCount-1});
 }
 const full=storesFor([job('v2-20260914T2002-0',0)]);
 assert.throws(()=>reserveRemoteLease(full,{now,activeLocalContainers:3,leaseToken:token}),error=>error instanceof LeaseError&&error.code==='GLOBAL_CAP');
});

test('iMac local reservation defers at fleet cap and skips a queue entry claimed remotely',()=>{
 const remote=job('v2-20260914T2002-2',2,'remote_started',{remoteHost:'macbook',leaseToken:token,leaseUntil:new Date(now+LEASE_MS).toISOString()});
 const candidate=job('v2-20260914T2002-3',3),full=storesFor([
  job('v2-20260914T2002-0',0,'started'),job('v2-20260914T2002-1',1,'started'),remote,candidate,
 ]);
 const deferred=reserveLocalJob(full,candidate.id,{now,activeLocalContainers:2});
 assert.equal(deferred.started,false);assert.equal(deferred.reason,'capacity');assert.equal(deferred.capacity.total,3);assert.equal(candidate.status,'pending');

 const selected=job('v2-20260914T2002-0',0),claimedStores=storesFor([selected]);
 reserveRemoteLease(claimedStores,{now,leaseToken:token});
 const skipped=reserveLocalJob(claimedStores,selected.id,{now,activeLocalContainers:0});
 assert.deepEqual(skipped,{started:false,reason:'not_pending'});assert.equal(selected.status,'remote_started');
});

test('peek remains available during local activity and reports remaining fleet capacity',async t=>{
 const root=fixture(t,[job('v2-20260914T2002-0',0,'started'),job('v2-20260914T2002-1',1,'started'),job('v2-20260914T2002-2',2)]);
 const result=await peekOperation({root,now});
 assert.equal(result.busy,false);assert.equal(result.available,true);assert.equal(result.activeLocalLedgerJobs,2);assert.equal(result.activeRemoteLeases,0);assert.equal(result.remainingCapacity,1);
});

test('broker registry phase releases scheduler lock and fresh merge writes preserve remote and local updates',async t=>{
 const localId='v2-20260914T2002-0',remoteId='v2-20260914T2002-1';
 const root=fixture(t,[job(localId,0,'started'),job(remoteId,1)]),lock=path.join(root,'.monitor-v2.lock');
 const vsix=Buffer.from('parallel fresh artifact'),hash=crypto.createHash('sha256').update(vsix).digest('hex');let calls=0,sawReservation=false;
 const registryFetchFactory=()=>async url=>{
  calls++;
  if(calls===1){
   assert.equal(fs.existsSync(lock),false,'registry I/O must not run under the scheduler lock');
   const release=acquirePidLock(lock);release();
   const file=path.join(root,'scheduler-v2.json'),state=JSON.parse(fs.readFileSync(file,'utf8'));
   assert.equal(state.jobs[remoteId].status,'remote_started');sawReservation=true;
   state.jobs[localId].status='passed';state.jobs[localId].finishedAt=new Date(now+5).toISOString();
   const temp=file+'.monitor-test.tmp';fs.writeFileSync(temp,JSON.stringify(state));fs.renameSync(temp,file);
  }
  if(url==='https://open-vsx.org/api/aryansudhir/promptr')return new Response(JSON.stringify({version:'1.5.6',files:{sha256:'https://open-vsx.org/hash',download:'https://open-vsx.org/download'}}));
  if(url.endsWith('/hash'))return new Response(hash);
  if(url.endsWith('/download'))return new Response(vsix);
  throw new Error('unexpected registry URL');
 };
 const result=await claimOperation({root,now,token,exec:async()=>({stdout:'promptr-check-local\n',stderr:''}),registryFetchFactory,clock:()=>now+10});
 assert.equal(result.claimed,true);assert.equal(result.jobId,remoteId);assert.equal(calls,3);assert.equal(sawReservation,true);
 const state=JSON.parse(fs.readFileSync(path.join(root,'scheduler-v2.json'),'utf8'));
 assert.equal(state.jobs[localId].status,'passed');assert.equal(state.jobs[remoteId].status,'remote_started');assert.equal(state.jobs[remoteId].expectedVersion,'1.5.6');assert.equal(state.jobs[remoteId].variant,result.variant);
});

test('expired MacBook cleanup stays fenced from both runners until confirmed',()=>{
 const expired=job('v2-20260914T2002-0',0,'remote_started',{remoteHost:'macbook',leaseToken:token,leaseUntil:new Date(now-1).toISOString()}),candidate=job('v2-20260914T2002-1',1);
 const stores=storesFor([expired,candidate]);expireRemoteLeases(stores,now);
 assert.equal(expired.status,'remote_cleanup_pending');assert.equal(activeRemoteLeases(stores).length,1);
 assert.throws(()=>reserveRemoteLease(stores,{now,leaseToken:'q'.repeat(43)}),error=>error.code==='REMOTE_ACTIVE');
 const local=reserveLocalJob(stores,candidate.id,{now,activeLocalContainers:2});assert.equal(local.started,false);assert.equal(local.reason,'capacity');
});

test('monitor uses a separate batch lock and only local iMac container labels',()=>{
 const source=fs.readFileSync(new URL('../imac/monitor.mjs',import.meta.url),'utf8');
 assert.match(source,/\.monitor-process\.lock/);assert.match(source,/\.monitor-v2\.lock/);
 assert.match(source,/name\.startsWith\('promptr-check-'\)/);
 assert.doesNotMatch(source,/macbook-fulltests|docker[^\n]+macbook/i);
});
