import fs from 'node:fs';
import path from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import {run} from './exec.mjs';
import {ROOT,DOCKER,atomic,eligibility,workerStatus,broker} from './runtime.mjs';
import {ensureImage} from './image.mjs';
import {DAY_WORKERS,overnightClaimPlan,readOvernight,workerCount} from './overnight.mjs';
import {fileURLToPath} from 'node:url';
import {acquireLocalLock} from './pid-lock.mjs';

export const MAX_MACBOOK_WORKERS=DAY_WORKERS;
const abort=new AbortController();let lastSettings=null;
// Observed, not required. It picks the SSH route to the broker: the direct home address while on
// the home network, the remote address once away. Completion and recovery always take the remote
// route so a check claimed at home can still be reported after leaving.
let lastHome=false;
// Losing the race for a shared slot is ordinary contention, not a failure. The broker owns
// claim serialization, so all lanes may peek and claim independently without duplicate jobs.
const CONTENDED=new Set(['BUSY','LOCAL_ACTIVE','REMOTE_ACTIVE','GLOBAL_CAP']);
const FATAL_BROKER=new Set(['INVALID_PLAN','CONFIG_INVALID','CONFIG_UNAVAILABLE','INVALID_OPERATION']);
const FINISHED_LEASE=new Set(['ILLEGAL_TRANSITION','UNKNOWN_JOB']);
const retryDelay=ms=>Number.isFinite(ms)?Math.min(15000,Math.max(2000,ms)):5000;
const retriableBroker=error=>!FATAL_BROKER.has(error?.code);

export function macbookContainerName(jobId){
 if(!/^[A-Za-z0-9_-]{1,160}$/.test(jobId))throw new Error('Invalid leased job identity');
 return 'macbook-check-'+jobId;
}
export function poolStatusSnapshot(activeChecks,update={}){
 const active=[...activeChecks.entries()].sort(([a],[b])=>a-b).map(([lane,check])=>({lane,jobId:check.jobId,target:check.target,variant:check.variant}));
 const status={phase:active.length?'running_check':update.phase,activeCount:active.length,activeChecks:active};
 for(const key of ['detail','error','jobId'])if(typeof update[key]==='string')status[key]=update[key];
 return status;
}
export async function runWorkerLanes(runLane,{count=MAX_MACBOOK_WORKERS,onFailure=()=>{}}={}){
 if(!Number.isInteger(count)||count<1)throw new Error('Invalid worker lane count');
 const outcomes=await Promise.allSettled(Array.from({length:count},(_,index)=>Promise.resolve().then(()=>runLane(index+1)).catch(error=>{onFailure(error,index+1);throw error;})));
 const failure=outcomes.find(outcome=>outcome.status==='rejected');if(failure)throw failure.reason;
 return outcomes.map(outcome=>outcome.value);
}
function createPoolStatus(){
 const activeChecks=new Map();
 const emit=update=>workerStatus(poolStatusSnapshot(activeChecks,update));
 return {
  start(lane,bundle){activeChecks.set(lane,{jobId:bundle.jobId,target:bundle.target,variant:bundle.variant});emit({phase:'running_check',detail:activeChecks.size+' active MacBook check'+(activeChecks.size===1?'':'s')+'.'});},
  finish(lane,update){activeChecks.delete(lane);emit(update);},
  report:emit,
 };
}
async function allowed(){
 let runtime;try{runtime=JSON.parse(fs.readFileSync(path.join(ROOT,'runtime.json'),'utf8'));}catch{return false;}
 lastSettings=runtime.settings;const fresh=runtime.configFresh&&Date.now()-Date.parse(runtime.updatedAt)<(runtime.settings.pollIntervalMinutes*60+30)*1000;
 const g=await eligibility(runtime.settings,{configFresh:fresh});lastHome=g.home;return g.eligible;
}
async function cleanupAll(){
 const r=await run(DOCKER,['ps','-aq','--filter','label=qa.macbook.runner=promptr-qa'],{timeout:10000});const ids=r.stdout.trim().split(/\s+/).filter(Boolean);if(ids.some(id=>!/^[A-Za-z0-9]+$/.test(id)))throw new Error('Unexpected Docker identity');
 if(ids.length)await run(DOCKER,['rm','-f',...ids],{timeout:20000});
}
async function cleanupContainer(name){
 if(!/^macbook-check-[A-Za-z0-9_-]{1,160}$/.test(name))throw new Error('Unexpected Docker container name');
 const r=await run(DOCKER,['ps','-aq','--filter','name=^/'+name+'$','--filter','label=qa.macbook.runner=promptr-qa'],{timeout:10000});const ids=r.stdout.trim().split(/\s+/).filter(Boolean);if(ids.some(id=>!/^[A-Za-z0-9]+$/.test(id))||ids.length>1)throw new Error('Unexpected Docker identity');
 if(ids.length)await run(DOCKER,['rm','-f',...ids],{timeout:20000});
}
async function complete(request,{deadline=Date.now()+120000}={}){
 while(Date.now()<deadline){try{return await broker('macbook-complete',request,{...lastSettings,requireHome:false},{timeout:20000});}catch(e){if(FINISHED_LEASE.has(e.code))return {ok:true,skipped:e.code};if(!retriableBroker(e)||['WRONG_TOKEN','INVALID_REQUEST','CLEANUP_NOT_CONFIRMED'].includes(e.code))throw e;await sleep(3000);}}
 throw new Error('Broker busy; completion saved for recovery');
}
async function recover(){
 // The outer worker PID mutex excludes another live worker. Reconcile once before lanes start.
 await cleanupAll();let state;
 for(let i=0;i<45;i++){try{state=await broker('macbook-recover',null,{...lastSettings,requireHome:false},{timeout:15000});break;}catch(e){if(!retriableBroker(e)||i===44)throw e;await sleep(3000);}}
 if(!state)throw new Error('Could not reconcile prior MacBook work');
 for(const lease of state.leases||[])await complete({jobId:lease.jobId,leaseToken:lease.leaseToken,status:'failed',seconds:0,reports:{},error:'Recovered after a MacBook interruption; owned containers removed',cleanupConfirmed:true});
 // Accepted or expired prior results are never replayed as new QA jobs.
 const outbox=path.join(ROOT,'outbox');if(fs.existsSync(outbox))for(const name of fs.readdirSync(outbox))if(name.endsWith('.json'))fs.unlinkSync(path.join(outbox,name));
}
function readReports(directory){
 const allowed=['installation.json','checks.json','download.json','timings.json','container.log','promptr-command-palette.png','cognispec-command-palette.png','failure.png'];const reports={};let total=0;
 for(const name of allowed){const f=path.join(directory,name);if(!fs.existsSync(f))continue;const st=fs.lstatSync(f);if(!st.isFile()||st.isSymbolicLink())throw new Error('Unexpected report file');const limit=name.endsWith('.png')?16*1024**2:name==='container.log'?8*1024**2:2*1024**2;if(st.size>limit)throw new Error('Report exceeded size limit');total+=st.size;if(total>23*1024**2)throw new Error('Combined reports exceed transport limit');reports[name]=fs.readFileSync(f).toString('base64');}
 return reports;
}
async function check(bundle,image,started,lane,poolStatus){
 if(!/^[A-Za-z0-9_-]{1,160}$/.test(bundle.jobId)||!['promptr','cognispec'].includes(bundle.target)||bundle.targetId!=='aryansudhir.'+bundle.target)throw new Error('Invalid leased job identity');
 const dir=path.join(ROOT,'jobs',bundle.jobId),results=path.join(dir,'results');fs.mkdirSync(results,{recursive:true,mode:0o700});const relayDir=path.join(dir,'relay');fs.mkdirSync(relayDir,{recursive:true,mode:0o700});const {leaseToken,...publicBundle}=bundle;atomic(path.join(relayDir,'bundle.json'),publicBundle);
 const activeName=macbookContainerName(bundle.jobId);let cleanupConfirmed=false,success=false,error='',finalStatus={phase:'waiting_for_work',detail:'Lane '+lane+' is waiting for work.'};poolStatus.start(lane,bundle);
 try{
  try{
   if(abort.signal.aborted||!await allowed())throw new Error('Eligibility changed before the check started');
   const r=await run(DOCKER,['run','--name',activeName,'--label','qa.macbook.runner=promptr-qa','--platform','linux/arm64','--network','none','--memory','2g','--memory-swap','2g','--cpus','2','--pids-limit','512','--shm-size','512m','-e','TARGET_EXTENSION='+bundle.targetId,'-e','TEST_RUN='+bundle.jobId,'-e','TEST_VARIANT='+bundle.variant,'-e','DAILY_PLAN_DATE='+bundle.downloadStart.slice(0,10),'-v',relayDir+':/relay:ro','-v',results+':/opt/check/results',image],{timeout:180000,signal:abort.signal,maxBuffer:8*1024*1024});fs.writeFileSync(path.join(results,'container.log'),r.stdout+r.stderr,{mode:0o600});success=true;
  }catch(e){error=abort.signal.aborted?'Eligibility changed or runner stopped':e.message;fs.writeFileSync(path.join(results,'container.log'),(e.stdout||'')+(e.stderr||'')+'\nRunner: '+error+'\n',{mode:0o600});}
  finally{
   try{await cleanupContainer(activeName);cleanupConfirmed=true;}catch{error='Owned container cleanup is unconfirmed; shared slot remains fenced';success=false;}
   fs.rmSync(path.join(relayDir,'bundle.json'),{force:true});
  }
  const request={jobId:bundle.jobId,leaseToken,status:success?'passed':'failed',seconds:(Date.now()-started)/1000,reports:readReports(results),error,cleanupConfirmed};
  const receipt=path.join(ROOT,'outbox',bundle.jobId+'.json');atomic(receipt,request);
  if(!cleanupConfirmed){finalStatus={phase:'needs_attention',detail:error,jobId:bundle.jobId};throw new Error(error);}
  try{await complete(request);fs.unlinkSync(receipt);finalStatus={phase:'waiting_for_work',detail:'Last check '+request.status,jobId:bundle.jobId};}
  catch(e){finalStatus={phase:'completion_pending',detail:'Result saved locally; no new work until reconciliation.',error:e.message,jobId:bundle.jobId};throw e;}
 }finally{poolStatus.finish(lane,finalStatus);}
}
function prune(){const jobs=path.join(ROOT,'jobs');if(!fs.existsSync(jobs))return;for(const name of fs.readdirSync(jobs)){const p=path.join(jobs,name),s=fs.lstatSync(p);if(s.isDirectory()&&!s.isSymbolicLink()&&Date.now()-s.mtimeMs>2*86400000)fs.rmSync(p,{recursive:true});}}
async function dockerMemoryBytes(){
 try{return Number(JSON.parse((await run(DOCKER,['info','--format','{{json .}}'],{timeout:10000,signal:abort.signal})).stdout).MemTotal)||0;}catch{return 0;}
}
function desiredWorkers(memTotalBytes){
 return workerCount({memTotalBytes,overnight:Boolean(readOvernight(ROOT))});
}
async function laneLoop(lane,image,poolStatus,memTotalBytes){
 while(!abort.signal.aborted){
  if(!await allowed())break;
  if(lane>desiredWorkers(memTotalBytes))break;
  const overnight=readOvernight(ROOT);
  const claimedPlan=overnightClaimPlan(lastSettings,{overnight,memTotalBytes});
  const plan={promptrDailyTotal:claimedPlan.promptrDailyTotal,cognispecDailyTotal:claimedPlan.cognispecDailyTotal};
  if(plan.promptrDailyTotal===0&&plan.cognispecDailyTotal===0){poolStatus.report({phase:'paused_plan',detail:'Both independently planned MacBook targets are set to 0/day.'});await sleep(15000,null,{signal:abort.signal});continue;}
  let peek;try{peek=await broker('macbook-peek',{plan},{...lastSettings,requireHome:lastHome},{signal:abort.signal,timeout:15000});}catch(e){if(abort.signal.aborted||!retriableBroker(e))throw e;poolStatus.report({phase:'waiting_for_work',detail:'Broker peek failed ('+e.message+'); retrying.'});await sleep(retryDelay(e.retryAfterMs),null,{signal:abort.signal});continue;}
  if(!peek.available){await sleep(15000,null,{signal:abort.signal});continue;}
  const start=Date.now();let bundle;try{bundle=await broker('macbook-claim',{plan},{...lastSettings,requireHome:lastHome},{signal:abort.signal,timeout:120000});}catch(e){
   if(abort.signal.aborted||!retriableBroker(e))throw e;
   poolStatus.report({phase:'waiting_for_work',detail:(CONTENDED.has(e.code)?'Shared fleet busy ('+e.message+')':'Broker claim failed ('+e.message+')')+'; retrying.'});
   await sleep(retryDelay(e.retryAfterMs),null,{signal:abort.signal});continue;
  }
  if(!bundle.claimed){await sleep(15000,null,{signal:abort.signal});continue;}
  await check(bundle,image,start,lane,poolStatus);
 }
}
async function main(){
 const lock=path.join(ROOT,'worker.pid'),releaseLock=await acquireLocalLock(lock,fileURLToPath(import.meta.url));if(!releaseLock)return;
 const stop=()=>abort.abort();process.on('SIGTERM',stop);process.on('SIGINT',stop);let checking=false;
 const guard=setInterval(async()=>{if(checking||abort.signal.aborted)return;checking=true;try{if(!await allowed())abort.abort();}catch{abort.abort();}finally{checking=false;}},15000);
 const poolStatus=createPoolStatus();let finalCleanupError=null,laneFailure=null;
 try{
  if(!await allowed())throw new Error('Not eligible');const image=await ensureImage(abort.signal);await recover();prune();
  const memTotalBytes=await dockerMemoryBytes(),lanes=desiredWorkers(memTotalBytes);
  poolStatus.report({phase:'waiting_for_work',detail:'Eligible; '+lanes+' MacBook lanes waiting for independently planned checks.'});
  await runWorkerLanes(lane=>laneLoop(lane,image,poolStatus,memTotalBytes),{count:lanes,onFailure:error=>{if(!abort.signal.aborted)laneFailure=error;abort.abort();}});
  poolStatus.report({phase:'paused',detail:'Eligibility changed; stopping owned work.'});
 }catch(e){const failure=laneFailure||e,paused=abort.signal.aborted&&!laneFailure;poolStatus.report({phase:paused?'paused':'needs_attention',detail:paused?'Eligibility changed; stopping owned work.':failure.message});console.error('MacBook worker:',paused?'paused':failure.message);}
 finally{
  clearInterval(guard);abort.abort();
  try{await cleanupAll();}catch(e){finalCleanupError=e;poolStatus.report({phase:'needs_attention',detail:'Final owned-container cleanup is unconfirmed.',error:e.message});}
  process.off('SIGTERM',stop);process.off('SIGINT',stop);releaseLock();
  if(finalCleanupError)process.exitCode=1;
 }
}
const invokedPath=process.argv[1]&&path.resolve(process.argv[1]);
if(invokedPath===fileURLToPath(import.meta.url))await main();
