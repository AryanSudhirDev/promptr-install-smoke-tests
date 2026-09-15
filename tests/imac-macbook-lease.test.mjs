import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
 LEASE_MS,MACBOOK_REMOTE_LEASE_CAP,LeaseError,acquirePidLock,activeRemoteLeases,advanceTargetWithRemoteFencing,applyFreshDownload,
 claimWithFreshFetch,completeRemoteLease,decodeReports,expireRemoteLeases,remoteCapacity,reserveRemoteLease,
} from '../imac/macbook-lease.mjs';
import {claimOperation,completeOperation,macbookPlanClaimOperation,peekOperation,recoverOperation} from '../imac/macbook-broker.mjs';
import {SLOT_MS} from '../imac/schedule.mjs';

const now=Date.parse('2026-09-14T17:02:00Z');
const token='a'.repeat(43);
const makeJob=(id='v2-20260914T1702-0',status='pending',extra={})=>({id,slot:now,index:0,plannedTotal:1400,status,target:'promptr',...extra});
const makeStores=(jobs=[makeJob()],total=1400)=>[
 {key:'promptr',id:'aryansudhir.promptr',total,state:{version:2,dailyTotal:1400,lastEnqueuedAt:now,jobs:Object.fromEntries(jobs.map(job=>[job.id,job])),missedSlots:0}},
 {key:'cognispec',id:'aryansudhir.cognispec',total:1189,state:{version:2,dailyTotal:1189,lastEnqueuedAt:now,jobs:{},missedSlots:0}},
];
const b64=value=>Buffer.from(typeof value==='string'?value:JSON.stringify(value)).toString('base64');
function claimed(stores=makeStores()){
 const reservation=reserveRemoteLease(stores,{now,leaseToken:token});
 applyFreshDownload(reservation,{expectedVersion:'1.5.6',sha256:'b'.repeat(64),downloadStart:new Date(now+1).toISOString(),downloadEnd:new Date(now+2).toISOString(),bytes:123});
 return {stores,reservation};
}
function passedReports(job){
 return {
  'installation.json':b64({targetId:job.targetId,variant:job.variant,expectedVersion:job.expectedVersion,freshStateBeforeInstall:true,artifactSha256:job.artifactSha256,installed:[`${job.targetId}@${job.expectedVersion}`],container:'macbook-fulltests-1'}),
  'checks.json':b64({variant:job.variant,status:'passed',checks:[{name:'activation',status:'passed'}]}),
  'download.json':b64({targetId:job.targetId,sha256:job.artifactSha256,manifest:{publisher:'aryansudhir',name:'promptr',version:job.expectedVersion}}),
  'container.log':b64('setup\nPROMPTR_EXTENDED_SMOKE_TEST_PASSED {}\n'),
 };
}

test('reserves only an already-planned pending enabled job and never passed work',()=>{
 const passed=makeJob('v2-20260914T1702-0','passed'),pending=makeJob('v2-20260914T1702-1','pending',{index:1});
 const stores=makeStores([passed,pending]);const result=reserveRemoteLease(stores,{now,leaseToken:token});
 assert.equal(result.job.id,pending.id);assert.equal(result.job.status,'remote_started');assert.equal(passed.status,'passed');
 assert.equal(result.job.remoteHost,'macbook');assert.equal(Date.parse(result.leaseUntil),now+LEASE_MS);
});

test('disabled target contributes no claim and does not mutate its pending job',()=>{
 const job=makeJob();const stores=makeStores([job],0);const result=reserveRemoteLease(stores,{now,leaseToken:token});
 assert.equal(result,null);assert.equal(job.status,'pending');
});

test('one remote lease and the global three-check cap are never exceeded',()=>{
 const first=makeJob(),second=makeJob('v2-20260914T1702-1','pending',{index:1});const stores=makeStores([first,second]);
 reserveRemoteLease(stores,{now,leaseToken:token});
 assert.deepEqual(remoteCapacity(stores,{now,activeLocalContainers:2}),{remote:1,local:2,total:3,remaining:0});
 assert.throws(()=>reserveRemoteLease(stores,{now,leaseToken:'c'.repeat(43)}),error=>error instanceof LeaseError&&error.code==='REMOTE_ACTIVE');
 const fresh=makeStores([makeJob()]);assert.throws(()=>reserveRemoteLease(fresh,{now,activeLocalContainers:3,leaseToken:token}),error=>error.code==='GLOBAL_CAP');
});

test('wrong token is rejected without changing the lease, and completed tokens cannot replay',()=>{
 const {stores,reservation}=claimed();const request={jobId:reservation.job.id,leaseToken:'z'.repeat(43),status:'passed',seconds:42,cleanupConfirmed:true,reports:passedReports(reservation.job)};
 assert.throws(()=>completeRemoteLease(stores,request,{now:now+1000}),error=>error.code==='WRONG_TOKEN');assert.equal(reservation.job.status,'remote_started');
 request.leaseToken=token;completeRemoteLease(stores,request,{now:now+2000});assert.equal(reservation.job.status,'passed');assert.equal(reservation.job.remoteSeconds,42);
 assert.throws(()=>completeRemoteLease(stores,request,{now:now+3000}),error=>error.code==='ILLEGAL_TRANSITION');
});

test('expired leases quarantine capacity until token-matched cleanup confirmation',()=>{
 const {stores,reservation}=claimed();const expired=expireRemoteLeases(stores,now+LEASE_MS+1);
 assert.equal(expired.length,1);assert.equal(reservation.job.status,'remote_cleanup_pending');assert.equal(reservation.job.leaseToken,token);
 assert.equal(activeRemoteLeases(stores).length,1);assert.deepEqual(remoteCapacity(stores,{now:now+LEASE_MS*20,activeLocalContainers:2}),{remote:1,local:2,total:3,remaining:0});
 assert.throws(()=>reserveRemoteLease(stores,{now:now+LEASE_MS*20,leaseToken:'c'.repeat(43)}),error=>error.code==='REMOTE_ACTIVE');
 const failed={jobId:reservation.job.id,leaseToken:'z'.repeat(43),status:'failed',seconds:601,cleanupConfirmed:true,reports:{},error:'container cleaned after lease expiry'};
 assert.throws(()=>completeRemoteLease(stores,failed,{now:now+LEASE_MS+2}),error=>error.code==='WRONG_TOKEN');assert.equal(reservation.job.status,'remote_cleanup_pending');
 failed.leaseToken=token;
 completeRemoteLease(stores,failed,{now:now+LEASE_MS+2});assert.equal(reservation.job.status,'failed');assert.equal(reservation.job.remoteCleanupConfirmed,true);assert.equal(reservation.job.leaseToken,undefined);assert.equal(activeRemoteLeases(stores).length,0);
});

test('cleanup confirmation is mandatory for both passed and failed completion',()=>{
 for(const status of ['passed','failed']){
  const {stores,reservation}=claimed(),request={jobId:reservation.job.id,leaseToken:token,status,seconds:2,reports:status==='passed'?passedReports(reservation.job):{},...(status==='failed'?{error:'test failure'}:{})};
  assert.throws(()=>completeRemoteLease(stores,request,{now:now+1}),error=>error.code==='CLEANUP_NOT_CONFIRMED');assert.equal(reservation.job.status,'remote_started');
 }
});

test('unexpired failed completion releases its fence only after cleanup acknowledgement',()=>{
 const {stores,reservation}=claimed();completeRemoteLease(stores,{jobId:reservation.job.id,leaseToken:token,status:'failed',seconds:3,cleanupConfirmed:true,reports:{},error:'test process failed'},{now:now+1});
 assert.equal(reservation.job.status,'failed');assert.equal(reservation.job.remoteCleanupConfirmed,true);assert.equal(activeRemoteLeases(stores).length,0);
});

test('an expired lease can never pass, even with valid proof and cleanup acknowledgement',()=>{
 const {stores,reservation}=claimed();const request={jobId:reservation.job.id,leaseToken:token,status:'passed',seconds:12,cleanupConfirmed:true,reports:passedReports(reservation.job)};
 assert.throws(()=>completeRemoteLease(stores,request,{now:now+LEASE_MS+1}),error=>error.code==='LEASE_EXPIRED'&&error.stateChanged);
 assert.equal(reservation.job.status,'remote_cleanup_pending');assert.equal(reservation.job.leaseToken,token);assert.equal(activeRemoteLeases(stores).length,1);
});

test('scheduler advancement cannot prune a fenced remote cleanup record',()=>{
 const old=makeJob('v2-20260901T1702-0','remote_cleanup_pending',{slot:now-8*86400000,remoteHost:'macbook',leaseToken:token,leaseUntil:new Date(now-8*86400000+LEASE_MS).toISOString()});
 const state=makeStores([old])[0].state,advanced=advanceTargetWithRemoteFencing(state,now,'promptr',1400);
 assert.equal(advanced.jobs[old.id],old);assert.equal(advanced.jobs[old.id].status,'remote_cleanup_pending');
});

test('failed checks, missing manifest, marker mismatch, and unsafe report names cannot pass',()=>{
 for(const mutate of [
  reports=>{reports['checks.json']=b64({variant:'manifest',status:'failed',checks:[]});},
  reports=>{reports['download.json']=b64({targetId:'aryansudhir.promptr',sha256:'b'.repeat(64)});},
  reports=>{reports['container.log']=b64('no success marker');},
 ]){
  const {stores,reservation}=claimed();const reports=passedReports(reservation.job);mutate(reports);
  assert.throws(()=>completeRemoteLease(stores,{jobId:reservation.job.id,leaseToken:token,status:'passed',seconds:2,cleanupConfirmed:true,reports},{now:now+1}));
  assert.equal(reservation.job.status,'remote_started');
 }
 assert.throws(()=>decodeReports({'registry-requests.jsonl':b64('overwrite')}),error=>error.code==='UNSAFE_REPORT_NAME');
 assert.throws(()=>decodeReports({'../checks.json':b64('{}')}),error=>error.code==='UNSAFE_REPORT_NAME');
});

test('fresh retrieval failure consumes the reserved job without retrying or returning pending',async()=>{
 const stores=makeStores(),events=[];let calls=0;
 await assert.rejects(claimWithFreshFetch(stores,{now,leaseToken:token,persist:store=>{if(store.key==='promptr')events.push(store.state.jobs[Object.keys(store.state.jobs)[0]].status);},retrieve:async()=>{calls++;throw new Error('network reset');}}),/network reset/);
 const job=stores[0].state.jobs['v2-20260914T1702-0'];assert.equal(calls,1);assert.deepEqual(events,['remote_started','failed']);assert.equal(job.status,'failed');assert.equal(job.leaseToken,undefined);
});

test('recover returns all outstanding tokens under the host lock and quarantines expired leases',async t=>{
 const root=fs.mkdtempSync(path.join(process.env.QA_TEST_TMP||os.tmpdir(),'macbook-recover-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 fs.writeFileSync(path.join(root,'config.json'),JSON.stringify({dailyTotal:1400,cognispecDailyTotal:1189}));
 const first=makeJob('v2-20260914T1702-0','remote_started',{remoteHost:'macbook',leaseToken:token,leaseUntil:new Date(now+LEASE_MS).toISOString()});
 const second=makeJob('cognispec-v2-20260914T1702-0','remote_started',{index:1,target:'cognispec',remoteHost:'macbook',leaseToken:'c'.repeat(43),leaseUntil:new Date(now-1).toISOString()});
 const stores=makeStores([first]);stores[1].state.jobs={[second.id]:second};
 fs.writeFileSync(path.join(root,'scheduler-v2.json'),JSON.stringify(stores[0].state));fs.writeFileSync(path.join(root,'scheduler-cognispec-v2.json'),JSON.stringify(stores[1].state));
 const result=await recoverOperation({root,now});assert.equal(result.ok,true);assert.equal(result.operation,'recover');
 assert.deepEqual(result.leases.map(({jobId,leaseToken,status})=>({jobId,leaseToken,status})),[
  {jobId:first.id,leaseToken:token,status:'remote_started'},
  {jobId:second.id,leaseToken:'c'.repeat(43),status:'remote_cleanup_pending'},
 ]);
 const saved=JSON.parse(fs.readFileSync(path.join(root,'scheduler-cognispec-v2.json')));assert.equal(saved.jobs[second.id].status,'remote_cleanup_pending');assert.equal(saved.jobs[second.id].leaseToken,'c'.repeat(43));assert.equal(fs.existsSync(path.join(root,'.monitor-v2.lock')),false);
 for(const lease of result.leases)await completeOperation({jobId:lease.jobId,leaseToken:lease.leaseToken,status:'failed',seconds:0,cleanupConfirmed:true,reports:{},error:'Recovered after worker crash and confirmed labeled containers absent'},{root,now:now+1});
 assert.equal(JSON.parse(fs.readFileSync(path.join(root,'scheduler-v2.json'))).jobs[first.id].status,'failed');assert.equal(JSON.parse(fs.readFileSync(path.join(root,'scheduler-cognispec-v2.json'))).jobs[second.id].status,'failed');
 assert.equal(fs.existsSync(path.join(root,'reports',first.id)),true);assert.equal(fs.existsSync(path.join(root,'reports',second.id)),true);
});

test('peek sees newly due slots by advancing memory only and writes nothing',async t=>{
 const root=fs.mkdtempSync(path.join(process.env.QA_TEST_TMP||os.tmpdir(),'macbook-peek-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 fs.writeFileSync(path.join(root,'config.json'),JSON.stringify({dailyTotal:1400,cognispecDailyTotal:0}));
 const state={version:2,dailyTotal:1400,lastEnqueuedAt:now-SLOT_MS,jobs:{},missedSlots:0},scheduler=path.join(root,'scheduler-v2.json');fs.writeFileSync(scheduler,JSON.stringify(state));
 const before=fs.readFileSync(scheduler);const result=await peekOperation({root,now});assert.equal(result.ok,true);assert.equal(result.available,true);assert.ok(result.pending>0);assert.ok(result.next.jobId.startsWith('v2-'));
 assert.deepEqual(fs.readFileSync(scheduler),before);assert.equal(fs.existsSync(path.join(root,'scheduler-cognispec-v2.json')),false);assert.equal(fs.existsSync(path.join(root,'.monitor-v2.lock')),false);
});

test('broker claim advances the shared ledgers, performs exactly three one-attempt relay requests, and writes host provenance',async t=>{
 const root=fs.mkdtempSync(path.join(process.env.QA_TEST_TMP||os.tmpdir(),'macbook-broker-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 fs.writeFileSync(path.join(root,'config.json'),JSON.stringify({dailyTotal:1400,cognispecDailyTotal:1189}));
 for(const [file,state] of [['scheduler-v2.json',makeStores()[0].state],['scheduler-cognispec-v2.json',makeStores()[1].state]])fs.writeFileSync(path.join(root,file),JSON.stringify(state));
 fs.mkdirSync(path.join(root,'registry-limit'));fs.writeFileSync(path.join(root,'registry-limit','state.json'),JSON.stringify({version:1,nextAllowedAt:0,cooldownUntil:0}));
 const vsix=Buffer.from('fresh relayed fixture'),hash=crypto.createHash('sha256').update(vsix).digest('hex'),requests=[];let options;
 const registryFetchFactory=input=>{options=input;return async url=>{requests.push(url);if(url==='https://open-vsx.org/api/aryansudhir/promptr')return new Response(JSON.stringify({version:'1.5.6',files:{sha256:'https://open-vsx.org/hash',download:'https://open-vsx.org/download'}}));if(url.endsWith('/hash'))return new Response(hash);if(url.endsWith('/download'))return new Response(vsix);throw new Error('unexpected URL');};};
 const result=await claimOperation({root,now,token,exec:async()=>({stdout:'',stderr:''}),registryFetchFactory,clock:()=>now+10});
 assert.equal(result.ok,true);assert.equal(result.claimed,true);assert.equal(result.jobId,'v2-20260914T1702-0');assert.equal(result.sha256,hash);assert.equal(Buffer.from(result.vsixBase64,'base64').toString(),'fresh relayed fixture');
 assert.equal(options.maxAttempts,1);assert.deepEqual(requests,['https://open-vsx.org/api/aryansudhir/promptr','https://open-vsx.org/hash','https://open-vsx.org/download']);
 const saved=JSON.parse(fs.readFileSync(path.join(root,'scheduler-v2.json')));assert.equal(saved.jobs[result.jobId].status,'remote_started');assert.equal(saved.jobs[result.jobId].expectedVersion,'1.5.6');
 const provenanceFile=path.join(root,'reports',result.jobId,'remote-download.json'),provenanceBefore=fs.readFileSync(provenanceFile);
 const provenance=JSON.parse(provenanceBefore);assert.equal(provenance.relayKind,'fresh-download-ssh-relay');assert.equal(provenance.cache,false);assert.equal(provenance.vsixRetained,false);
 const peek=await peekOperation({root,now:now+20});assert.equal(peek.available,false);assert.equal(peek.activeRemoteLeases,1);
 const journal=path.join(root,'reports',result.jobId,'registry-requests.jsonl');fs.writeFileSync(journal,'host registry journal\n');
 const evidenceJob={target:result.target,targetId:result.targetId,variant:result.variant,expectedVersion:result.expectedVersion,artifactSha256:result.sha256};
 const completed=await completeOperation({jobId:result.jobId,leaseToken:result.leaseToken,status:'passed',seconds:12,cleanupConfirmed:true,reports:passedReports(evidenceJob)},{root,now:now+100});
 assert.equal(completed.status,'passed');assert.deepEqual(fs.readFileSync(provenanceFile),provenanceBefore);assert.equal(fs.readFileSync(journal,'utf8'),'host registry journal\n');
 assert.equal(JSON.parse(fs.readFileSync(path.join(root,'scheduler-v2.json'))).jobs[result.jobId].status,'passed');
});

test('PID lock returns busy for live holders and never deletes invalid PID locks',t=>{
 const dir=fs.mkdtempSync(path.join(process.env.QA_TEST_TMP||os.tmpdir(),'macbook-lock-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const lock=path.join(dir,'.monitor-v2.lock');
 fs.writeFileSync(lock,'123');assert.throws(()=>acquirePidLock(lock,{pid:456,isAlive:()=>true}),error=>error.code==='BUSY');assert.equal(fs.readFileSync(lock,'utf8'),'123');
 fs.writeFileSync(lock,'not-a-pid');assert.throws(()=>acquirePidLock(lock,{pid:456,isAlive:()=>false}),error=>error.code==='INVALID_LOCK');assert.equal(fs.readFileSync(lock,'utf8'),'not-a-pid');
 fs.writeFileSync(lock,'123');const release=acquirePidLock(lock,{pid:456,isAlive:()=>false});assert.equal(fs.readFileSync(lock,'utf8'),'456');release();assert.equal(fs.existsSync(lock),false);
});


test('MacBook plan has an independent three-lease cap and cleanup-pending leases remain counted',async t=>{
 const root=fs.mkdtempSync(path.join(process.env.QA_TEST_TMP||os.tmpdir(),'macbook-independent-cap-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const planRoot=path.join(root,'macbook-plan'),plan={promptrDailyTotal:1400,cognispecDailyTotal:0};
 fs.mkdirSync(path.join(root,'registry-limit'),{recursive:true});fs.writeFileSync(path.join(root,'registry-limit','state.json'),JSON.stringify({version:1,nextAllowedAt:0,cooldownUntil:0}));
 const jobs=[0,1,2,3].map(index=>makeJob(`macbook-v2-20260914T1702-${index}`,'pending',{index}));
 fs.mkdirSync(planRoot,{recursive:true});fs.writeFileSync(path.join(planRoot,'scheduler-v2.json'),JSON.stringify(makeStores(jobs)[0].state));
 const bytes=Buffer.from('independent cap fixture'),hash=crypto.createHash('sha256').update(bytes).digest('hex');
 const registryFetchFactory=()=>async url=>url.includes('/api/')?new Response(JSON.stringify({version:'1.5.6',files:{sha256:'https://open-vsx.org/hash',download:'https://open-vsx.org/download'}})):url.endsWith('/hash')?new Response(hash):new Response(bytes);
 const options={planRoot,limiterRoot:root,now,externalRemoteCount:99,exec:async()=>({stdout:'promptr-check-imac-a\npromptr-check-imac-b\npromptr-check-imac-c\n',stderr:''}),registryFetchFactory,clock:()=>now+1};
 const first=await macbookPlanClaimOperation(plan,{...options,token:'a'.repeat(43)});
 const ledger=path.join(planRoot,'scheduler-v2.json'),state=JSON.parse(fs.readFileSync(ledger,'utf8'));
 state.jobs[first.jobId].status='remote_cleanup_pending';fs.writeFileSync(ledger,JSON.stringify(state));
 const second=await macbookPlanClaimOperation(plan,{...options,token:'b'.repeat(43)}),third=await macbookPlanClaimOperation(plan,{...options,token:'c'.repeat(43)});
 assert.equal(first.claimed,true);assert.equal(second.claimed,true);assert.equal(third.claimed,true);
 const saved=JSON.parse(fs.readFileSync(ledger,'utf8')),leases=Object.values(saved.jobs).filter(job=>job.remoteHost==='macbook'&&['remote_started','remote_cleanup_pending'].includes(job.status));
 assert.equal(leases.length,MACBOOK_REMOTE_LEASE_CAP);assert.equal(leases.filter(job=>job.status==='remote_cleanup_pending').length,1);
 await assert.rejects(macbookPlanClaimOperation(plan,{...options,token:'d'.repeat(43)}),error=>error instanceof LeaseError&&error.code==='REMOTE_ACTIVE');
});
