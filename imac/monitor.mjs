import fs from 'node:fs';
import path from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';
import {boundedExec as exec} from './exec-bounded.mjs';
import {validTotal} from './schedule.mjs';
import {TARGETS,selectJobs,diskAllowsStart} from './multi-plan.mjs';
import {
 GLOBAL_CHECK_CAP,LeaseError,acquirePidLock,activeRemoteLeases,advanceTargetWithRemoteFencing,
 expireRemoteLeases,ledgerLocalActivity,reserveLocalJob,
} from './macbook-lease.mjs';
import registryLimiter from './registry-fetch.cjs';
const {initializeLimiter,readState:readLimiterState,SPACING_MS}=registryLimiter;
const here=path.dirname(fileURLToPath(import.meta.url));
const limiterDir=path.join(here,'registry-limit'),stateLock=path.join(here,'.monitor-v2.lock'),processLock=path.join(here,'.monitor-process.lock');
const statusFile=path.join(here,'status-v2.json');
const atomic=(file,data)=>{const tmp=file+'.tmp';fs.writeFileSync(tmp,JSON.stringify(data,null,2)+'\n');fs.renameSync(tmp,file);};
let releaseProcess;
try{releaseProcess=acquirePidLock(processLock);}
catch(error){if(error instanceof LeaseError&&error.code==='BUSY'){console.log('[monitor] another instance is active');process.exit(0);}throw error;}
process.on('exit',()=>{try{releaseProcess();}catch{}});

async function withStateLock(action){
 while(true){
  let release;
  try{release=acquirePidLock(stateLock);}
  catch(error){if(error instanceof LeaseError&&error.code==='BUSY'){await sleep(50);continue;}throw error;}
  try{return await action();}finally{release();}
 }
}

let totals={promptr:100,cognispec:0};
const validOptional=n=>n===0||validTotal(n);
try{const c=JSON.parse(fs.readFileSync(path.join(here,'config.json')));if(validTotal(c.dailyTotal))totals.promptr=c.dailyTotal;if(validOptional(c.cognispecDailyTotal))totals.cognispec=c.cognispecDailyTotal;}catch{}
try{
 const r=await fetch('https://raw.githubusercontent.com/AryanSudhirDev/promptr-install-smoke-tests/main/monitor-config.json?t='+Date.now(),{signal:AbortSignal.timeout(15000),headers:{'Cache-Control':'no-cache'}});
 if(!r.ok)throw new Error('HTTP '+r.status);const c=await r.json();const second=c.cognispecDailyTotal??0;
 if(!validTotal(c.imacDailyTotal)||!validOptional(second))throw new Error('invalid target rates');
 totals={promptr:c.imacDailyTotal,cognispec:second};atomic(path.join(here,'config.json'),{dailyTotal:totals.promptr,cognispecDailyTotal:totals.cognispec,source:'repo',at:new Date().toISOString()});
}catch(e){console.log('[monitor] remote config unavailable; using local rates: '+e.message);}
if(process.env.DAILY_TOTAL){const n=Number(process.env.DAILY_TOTAL);if(!validTotal(n))throw new Error('invalid DAILY_TOTAL');totals.promptr=n;}

function loadStores({at=Date.now(),advance=false}={}){
 return Object.entries(TARGETS).map(([key,target])=>{
  const file=path.join(here,target.file);const old=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):null;
  const state=advance?advanceTargetWithRemoteFencing(old,at,key,totals[key]):old;
  return {...target,key,total:totals[key],file,state};
 });
}
const persist=store=>{if(store.state)atomic(store.file,store.state);};
let stores=await withStateLock(()=>{
 const fresh=loadStores({at:Date.now(),advance:true});expireRemoteLeases(fresh,Date.now());
 for(const store of fresh)persist(store);return fresh;
});
const allJobs=(source=stores)=>source.flatMap(store=>Object.values(store.state?.jobs||{}).map(job=>({job,store})));
const pending=()=>selectJobs(stores,Infinity).length;
const freeBytes=()=>{const s=fs.statfsSync(here);return Number(s.bavail)*Number(s.bsize);};
async function refreshStores(){stores=await withStateLock(()=>loadStores());return stores;}
async function blocked(reason){
 try{await refreshStores();}catch{}
 const status={at:new Date().toISOString(),schedulerVersion:2,dailyTotal:totals.promptr,targetDailyTotals:totals,totalDailyChecks:totals.promptr+totals.cognispec,slotsPerDay:288,phase:'blocked',error:reason,pending:pending()};
 atomic(statusFile,status);console.error('[monitor] '+JSON.stringify(status));
}
async function removeContainer(name){try{await exec('docker',['rm','-f',name],{timeout:20000});}catch(e){if(!/No such (container|object)/i.test(e.stderr||''))throw e;}}
async function countActiveLocalContainers(){
 const r=await exec('docker',['ps','--format','{{.Names}}'],{timeout:10000});
 return r.stdout.split(/\r?\n/).filter(name=>name.startsWith('promptr-check-')).length;
}
function independentMacBookRemoteCount(){
 let n=0;for(const file of ['scheduler-v2.json','scheduler-cognispec-v2.json'])try{const state=JSON.parse(fs.readFileSync(path.join(here,'macbook-plan',file),'utf8'));for(const job of Object.values(state.jobs||{}))if(job.remoteHost==='macbook'&&['remote_started','remote_cleanup_pending'].includes(job.status))n++;}catch{}
 return n;
}
async function mutateLocalJob(jobId,mutate){
 return withStateLock(()=>{
  const fresh=loadStores();let selected;
  for(const store of fresh){const job=store.state?.jobs?.[jobId];if(job){selected={store,job};break;}}
  if(!selected)return null;
  const value=mutate(selected);
  if(value!==false)persist(selected.store);
  stores=fresh;return value===false?null:selected;
 });
}

try{
 try{await exec('docker',['info','--format','{{.NCPU}}'],{timeout:10000});}
 catch{await exec('colima',['start','--vm-type','vz','--cpu','4','--memory','6','--disk','10'],{timeout:120000});await exec('docker',['info','--format','{{.NCPU}}'],{timeout:10000});}
}catch(e){await blocked('Docker unavailable: '+e.message);process.exit(1);}
for(const {job} of allJobs().filter(({job})=>['started','cleanup_pending'].includes(job.status)&&job.remoteHost!=='macbook')){
 try{await removeContainer('promptr-check-'+job.id);}
 catch(e){await mutateLocalJob(job.id,({job:fresh})=>{fresh.status='cleanup_pending';fresh.cleanupError=e.message;});await blocked('Container cleanup unavailable: '+e.message);process.exit(1);}
 await mutateLocalJob(job.id,({job:fresh})=>{if(!['started','cleanup_pending'].includes(fresh.status)||fresh.remoteHost==='macbook')return false;fresh.status='interrupted';fresh.finishedAt=new Date().toISOString();});
}
try{
 const r=await exec('docker',['ps','-a','--format','{{.Names}}'],{timeout:10000});
 if(r.stdout.split(/\r?\n/).some(name=>name.startsWith('promptr-check-')))throw new Error('Prior local QA container still exists');
 await withStateLock(()=>{
  const fresh=loadStores();
  if(activeRemoteLeases(fresh).length===0)initializeLimiter(limiterDir,{containersAbsent:true});
  else readLimiterState(limiterDir); // Never recover/reset a limiter a remote fenced job may be using.
  stores=fresh;
 });
 if(!diskAllowsStart(fs.statfsSync(here)))throw new Error('Less than 5 GiB disk space remains; new checks paused');
}catch(e){await blocked('Safety preflight: '+e.message);process.exit(1);}

const maxPerRun=process.env.MAX_JOBS_PER_RUN?Number(process.env.MAX_JOBS_PER_RUN):100,timeBudget=20*60000;
if(!Number.isInteger(maxPerRun)||maxPerRun<1||maxPerRun>100)throw new Error('invalid MAX_JOBS_PER_RUN');
let cleanupBlocked=false,ratePaused=false,limiterBlocked=false,diskPaused=false;
function canStart(){
 if(cleanupBlocked||limiterBlocked||ratePaused||diskPaused)return false;
 if(readLimiterState(limiterDir).cooldownUntil>Date.now()){ratePaused=true;return false;}
 if(!diskAllowsStart(fs.statfsSync(here))){diskPaused=true;return false;}
 return true;
}
const due=selectJobs(stores,maxPerRun),queue=[...due],results=[];
console.log(`[monitor] ${new Date().toISOString()} rates=${JSON.stringify(totals)}/day pending=${pending()} batch=${due.length} local-concurrency=${Math.max(0,GLOBAL_CHECK_CAP-activeRemoteLeases(stores).length)} active-remote=${activeRemoteLeases(stores).length} shared-cap=${GLOBAL_CHECK_CAP}`);
const started=Date.now();
const phase=()=>cleanupBlocked||limiterBlocked||diskPaused?'blocked':ratePaused?'cooldown':'idle';
async function publish(currentPhase='running'){
 await refreshStores();
 const remote=activeRemoteLeases(stores),local=ledgerLocalActivity(stores);
 const targetResults=Object.fromEntries(stores.map(store=>{const rows=results.filter(r=>r.target===store.key);return [store.key,{dailyTotal:store.total,passed:rows.filter(j=>j.status==='passed').length,failed:rows.filter(j=>['failed','cleanup_pending'].includes(j.status)).length,pending:selectJobs([store],Infinity).length}];}));
 const summary={at:new Date().toISOString(),schedulerVersion:2,dailyTotal:totals.promptr,targetDailyTotals:totals,totalDailyChecks:totals.promptr+totals.cognispec,targetResults,slotsPerDay:288,phase:currentPhase,freeDiskGiB:Math.round(freeBytes()/1024**3*100)/100,registryLimiter:{spacingMs:SPACING_MS,cooldownUntil:readLimiterState(limiterDir).cooldownUntil},sharedConcurrencyCap:GLOBAL_CHECK_CAP,activeRemoteLeases:remote.length,remoteCleanupPending:remote.filter(({job})=>job.status==='remote_cleanup_pending').length,localConcurrency:Math.max(0,GLOBAL_CHECK_CAP-remote.length),activeLocalLedgerJobs:local.length,selected:due.length,due:results.length,passed:results.filter(j=>j.status==='passed').length,failed:results.filter(j=>['failed','cleanup_pending'].includes(j.status)).length,pending:pending(),missedSlots:stores.reduce((n,s)=>n+(s.state?.missedSlots||0),0),expired:allJobs().filter(({job})=>job.status==='expired').length,interrupted:allJobs().filter(({job})=>job.status==='interrupted').length,slots:[...new Set(results.map(j=>new Date(j.slot).toISOString()))]};
 if(diskPaused)summary.error='Less than 5 GiB disk space remains; new checks paused';
 atomic(statusFile,summary);return summary;
}
await publish();

async function reserveCandidate(candidate){
 const activeLocalContainers=await countActiveLocalContainers();
 return withStateLock(()=>{
  const fresh=loadStores(),expired=expireRemoteLeases(fresh,Date.now());
  const reservation=reserveLocalJob(fresh,candidate.job.id,{now:Date.now(),activeLocalContainers,externalRemoteCount:independentMacBookRemoteCount()});
  const changed=new Set(expired.map(({store})=>store));if(reservation.started)changed.add(reservation.store);
  for(const store of changed)persist(store);
  stores=fresh;return reservation;
 });
}
async function run(reservation){
 const {job,store,variant}=reservation,out=path.join(here,'reports',job.id);fs.mkdirSync(out,{recursive:true});
 const begin=Date.now(),name='promptr-check-'+job.id;let update;
 try{
  const r=await exec('docker',['run','--rm','--name',name,'--memory','2g','--shm-size','512m',
   '-e','TARGET_EXTENSION='+store.id,'-e','REGISTRY_LIMIT_DIR=/opt/check/registry-limit','-e','TEST_VARIANT='+variant,'-e','TEST_RUN='+job.id,'-e','DAILY_PLAN_DATE='+new Date(job.slot).toISOString().slice(0,10),
   '-v',limiterDir+':/opt/check/registry-limit','-v',path.join(here,'registry-fetch.cjs')+':/opt/check/registry-fetch.cjs:ro',
   '-v',path.join(here,'container-check.cjs')+':/opt/check/container-check.cjs:ro','-v',path.join(here,'install-lifecycle.cjs')+':/opt/check/install-lifecycle.cjs:ro','-v',path.join(here,'wait-for-setting.cjs')+':/opt/check/wait-for-setting.cjs:ro','-v',out+':/opt/check/results','-v',path.join(here,store.suite)+':/opt/check/extended-suite.cjs:ro',process.env.MONITOR_IMAGE||'promptr-install-check:local'],{timeout:5*60000});
  fs.writeFileSync(path.join(out,'container.log'),r.stdout+'\n--- stderr ---\n'+r.stderr);
  if(!r.stdout.includes(store.marker))throw new Error('target test success marker missing');update={status:'passed'};
 }catch(e){
  update={status:'failed',error:String(e.message).slice(0,200)};
  if(e.stdout||e.stderr)fs.writeFileSync(path.join(out,'container.log'),(e.stdout||'')+'\n--- stderr ---\n'+(e.stderr||''));
  try{await removeContainer(name);}catch(cleanupError){cleanupBlocked=true;update.status='cleanup_pending';update.cleanupError=cleanupError.message;}
  if(fs.existsSync(path.join(limiterDir,'lock'))){try{if(JSON.parse(fs.readFileSync(path.join(limiterDir,'lock','owner.json'))).runId===job.id)limiterBlocked=true;}catch{limiterBlocked=true;}}
  if((e.stdout||'').includes('PROMPTR_REGISTRY_COOLDOWN')||(e.stderr||'').includes('PROMPTR_REGISTRY_COOLDOWN'))ratePaused=true;
 }
 update.seconds=Math.round((Date.now()-begin)/100)/10;update.finishedAt=new Date().toISOString();
 const saved=await mutateLocalJob(job.id,({job:fresh})=>{if(fresh.status!=='started'||fresh.remoteHost==='macbook')return false;Object.assign(fresh,update);});
 if(saved){const result={...saved.job};results.push(result);await publish(phase()==='idle'?'running':phase());console.log(`[monitor] ${job.id} ${store.key}/${variant}: ${result.status} in ${result.seconds}s`);}
}
async function worker(){
 while(queue.length&&Date.now()-started<timeBudget&&canStart()){
  const candidate=queue.shift();let reservation;
  while(Date.now()-started<timeBudget&&canStart()){
   reservation=await reserveCandidate(candidate);
   if(reservation.started||reservation.reason==='not_pending')break;
   await sleep(250);
  }
  if(reservation?.started)await run(reservation);
 }
}
await Promise.all(Array.from({length:GLOBAL_CHECK_CAP},worker));
const summary=await publish(phase());fs.appendFileSync(path.join(here,'history.jsonl'),JSON.stringify(summary)+'\n');console.log('[monitor] '+JSON.stringify(summary));
process.exitCode=summary.failed||cleanupBlocked||limiterBlocked||diskPaused?1:0;
