import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {boundedExec as exec} from './exec-bounded.mjs';
import {validTotal} from './schedule.mjs';
import {TARGETS,advanceTarget,selectJobs,diskAllowsStart} from './multi-plan.mjs';
import registryLimiter from './registry-fetch.cjs';
const {initializeLimiter,readState:readLimiterState,SPACING_MS}=registryLimiter;
const here=path.dirname(fileURLToPath(import.meta.url));
const limiterDir=path.join(here,'registry-limit'),lock=path.join(here,'.monitor-v2.lock');
const statusFile=path.join(here,'status-v2.json');
const atomic=(file,data)=>{const tmp=file+'.tmp';fs.writeFileSync(tmp,JSON.stringify(data,null,2)+'\n');fs.renameSync(tmp,file);};
function acquire(){
 try{fs.writeFileSync(lock,String(process.pid),{flag:'wx'});return true;}catch(e){if(e.code!=='EEXIST')throw e;}
 const pid=Number(fs.readFileSync(lock,'utf8'));if(!Number.isInteger(pid)||pid<1)throw new Error('invalid lock; manual inspection needed');
 try{process.kill(pid,0);return false;}catch(e){if(e.code!=='ESRCH')return false;}
 fs.unlinkSync(lock);fs.writeFileSync(lock,String(process.pid),{flag:'wx'});return true;
}
if(!acquire()){console.log('[monitor] another instance is active');process.exit(0);}
process.on('exit',()=>{try{if(fs.readFileSync(lock,'utf8')===String(process.pid))fs.unlinkSync(lock);}catch{}});
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
const now=Date.now();
const stores=Object.entries(TARGETS).map(([key,target])=>{
 const file=path.join(here,target.file);const old=fs.existsSync(file)?JSON.parse(fs.readFileSync(file)):null;
 const state=advanceTarget(old,now,key,totals[key]);const store={...target,key,total:totals[key],file,state};if(state)atomic(file,state);return store;
});
const persist=store=>{if(store.state)atomic(store.file,store.state);};
const allJobs=()=>stores.flatMap(store=>Object.values(store.state?.jobs||{}).map(job=>({job,store})));
const pending=()=>selectJobs(stores,Infinity).length;
const freeBytes=()=>{const s=fs.statfsSync(here);return Number(s.bavail)*Number(s.bsize);};
function blocked(reason){const status={at:new Date().toISOString(),schedulerVersion:2,dailyTotal:totals.promptr,targetDailyTotals:totals,totalDailyChecks:totals.promptr+totals.cognispec,slotsPerDay:288,phase:'blocked',error:reason,pending:pending()};atomic(statusFile,status);console.error('[monitor] '+JSON.stringify(status));}
async function removeContainer(name){try{await exec('docker',['rm','-f',name],{timeout:20000});}catch(e){if(!/No such (container|object)/i.test(e.stderr||''))throw e;}}
try{
 try{await exec('docker',['info','--format','{{.NCPU}}'],{timeout:10000});}
 catch{await exec('colima',['start','--vm-type','vz','--cpu','4','--memory','6','--disk','10'],{timeout:120000});await exec('docker',['info','--format','{{.NCPU}}'],{timeout:10000});}
}catch(e){blocked('Docker unavailable: '+e.message);process.exit(1);}
for(const {job,store} of allJobs().filter(({job})=>['started','cleanup_pending'].includes(job.status))){
 try{await removeContainer('promptr-check-'+job.id);}catch(e){job.status='cleanup_pending';persist(store);blocked('Container cleanup unavailable: '+e.message);process.exit(1);}
 job.status='interrupted';job.finishedAt=new Date().toISOString();persist(store);
}
try{
 const r=await exec('docker',['ps','-a','--format','{{.Names}}'],{timeout:10000});
 if(r.stdout.split(/\r?\n/).some(name=>name.startsWith('promptr-check-')))throw new Error('Prior QA container still exists');
 initializeLimiter(limiterDir,{containersAbsent:true});
 if(!diskAllowsStart(fs.statfsSync(here)))throw new Error('Less than 5 GiB disk space remains; new checks paused');
}catch(e){blocked('Safety preflight: '+e.message);process.exit(1);}
const concurrency=3,maxPerRun=process.env.MAX_JOBS_PER_RUN?Number(process.env.MAX_JOBS_PER_RUN):100,timeBudget=20*60000;
if(!Number.isInteger(maxPerRun)||maxPerRun<1||maxPerRun>100)throw new Error('invalid MAX_JOBS_PER_RUN');
let cleanupBlocked=false,ratePaused=false,limiterBlocked=false,diskPaused=false;
function canStart(){
 if(cleanupBlocked||limiterBlocked||ratePaused||diskPaused)return false;
 if(readLimiterState(limiterDir).cooldownUntil>Date.now()){ratePaused=true;return false;}
 if(!diskAllowsStart(fs.statfsSync(here))){diskPaused=true;return false;}
 return true;
}
const due=selectJobs(stores,maxPerRun),queue=[...due],results=[];
console.log(`[monitor] ${new Date().toISOString()} rates=${JSON.stringify(totals)}/day pending=${pending()} batch=${due.length} shared-concurrency=${concurrency}`);
const variants=['manifest','clean-state','settings-isolation','ui-settings','reinstall','duplicate-install'];
const started=Date.now();
const phase=()=>cleanupBlocked||limiterBlocked||diskPaused?'blocked':ratePaused?'cooldown':'idle';
function publish(currentPhase='running'){
 const targetResults=Object.fromEntries(stores.map(store=>{const rows=results.filter(r=>r.target===store.key);return [store.key,{dailyTotal:store.total,passed:rows.filter(j=>j.status==='passed').length,failed:rows.filter(j=>['failed','cleanup_pending'].includes(j.status)).length,pending:selectJobs([store],Infinity).length}];}));
 const summary={at:new Date().toISOString(),schedulerVersion:2,dailyTotal:totals.promptr,targetDailyTotals:totals,totalDailyChecks:totals.promptr+totals.cognispec,targetResults,slotsPerDay:288,phase:currentPhase,freeDiskGiB:Math.round(freeBytes()/1024**3*100)/100,registryLimiter:{spacingMs:SPACING_MS,cooldownUntil:readLimiterState(limiterDir).cooldownUntil},selected:due.length,due:results.length,passed:results.filter(j=>j.status==='passed').length,failed:results.filter(j=>['failed','cleanup_pending'].includes(j.status)).length,pending:pending(),missedSlots:stores.reduce((n,s)=>n+(s.state?.missedSlots||0),0),expired:allJobs().filter(({job})=>job.status==='expired').length,interrupted:allJobs().filter(({job})=>job.status==='interrupted').length,slots:[...new Set(results.map(j=>new Date(j.slot).toISOString()))]};
 if(diskPaused)summary.error='Less than 5 GiB disk space remains; new checks paused';
 atomic(statusFile,summary);return summary;
}
publish();
async function run({job,store}){
 const out=path.join(here,'reports',job.id);fs.mkdirSync(out,{recursive:true});
 const variant=variants[(Math.floor(job.slot/300000)+job.index)%variants.length];
 job.target=store.key;job.status='started';job.startedAt=new Date().toISOString();persist(store);
 const begin=Date.now(),name='promptr-check-'+job.id;
 try{
  const r=await exec('docker',['run','--rm','--name',name,'--memory','2g','--shm-size','512m',
   '-e','TARGET_EXTENSION='+store.id,'-e','REGISTRY_LIMIT_DIR=/opt/check/registry-limit','-e','TEST_VARIANT='+variant,'-e','TEST_RUN='+job.id,'-e','DAILY_PLAN_DATE='+new Date(job.slot).toISOString().slice(0,10),
   '-v',limiterDir+':/opt/check/registry-limit','-v',path.join(here,'registry-fetch.cjs')+':/opt/check/registry-fetch.cjs:ro',
   '-v',path.join(here,'container-check.cjs')+':/opt/check/container-check.cjs:ro','-v',out+':/opt/check/results','-v',path.join(here,store.suite)+':/opt/check/extended-suite.cjs:ro',process.env.MONITOR_IMAGE||'promptr-install-check:local'],{timeout:5*60000});
  fs.writeFileSync(path.join(out,'container.log'),r.stdout+'\n--- stderr ---\n'+r.stderr);
  if(!r.stdout.includes(store.marker))throw new Error('target test success marker missing');job.status='passed';
 }catch(e){
  job.status='failed';job.error=String(e.message).slice(0,200);
  if(e.stdout||e.stderr)fs.writeFileSync(path.join(out,'container.log'),(e.stdout||'')+'\n--- stderr ---\n'+(e.stderr||''));
  try{await removeContainer(name);}catch(cleanupError){cleanupBlocked=true;job.status='cleanup_pending';job.cleanupError=cleanupError.message;}
  if(fs.existsSync(path.join(limiterDir,'lock'))){try{if(JSON.parse(fs.readFileSync(path.join(limiterDir,'lock','owner.json'))).runId===job.id)limiterBlocked=true;}catch{limiterBlocked=true;}}
  if((e.stdout||'').includes('PROMPTR_REGISTRY_COOLDOWN')||(e.stderr||'').includes('PROMPTR_REGISTRY_COOLDOWN'))ratePaused=true;
 }
 job.seconds=Math.round((Date.now()-begin)/100)/10;job.finishedAt=new Date().toISOString();persist(store);results.push(job);publish(phase()==='idle'?'running':phase());
 console.log(`[monitor] ${job.id} ${store.key}/${variant}: ${job.status} in ${job.seconds}s`);
}
await Promise.all(Array.from({length:concurrency},async()=>{while(queue.length&&Date.now()-started<timeBudget&&canStart())await run(queue.shift());}));
const summary=publish(phase());fs.appendFileSync(path.join(here,'history.jsonl'),JSON.stringify(summary)+'\n');console.log('[monitor] '+JSON.stringify(summary));
process.exitCode=summary.failed||cleanupBlocked||limiterBlocked||diskPaused?1:0;
