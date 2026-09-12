import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {boundedExec as exec} from './exec-bounded.mjs';
import {initialState,advance,pendingJobs,validTotal} from './schedule.mjs';
const here=path.dirname(fileURLToPath(import.meta.url));
const stateFile=path.join(here,'scheduler-v2.json'),lock=path.join(here,'.monitor-v2.lock');
const atomic=(file,data)=>{const tmp=file+'.tmp';fs.writeFileSync(tmp,JSON.stringify(data,null,2)+'\n');fs.renameSync(tmp,file);};
function acquire(){
  try{fs.writeFileSync(lock,String(process.pid),{flag:'wx'});return true;}
  catch(e){if(e.code!=='EEXIST')throw e;}
  const pid=Number(fs.readFileSync(lock,'utf8'));if(!Number.isInteger(pid)||pid<1)throw new Error('invalid lock; manual inspection needed');
  try{process.kill(pid,0);return false;}catch(e){if(e.code!=='ESRCH')return false;}
  fs.unlinkSync(lock);fs.writeFileSync(lock,String(process.pid),{flag:'wx'});return true;
}
if(!acquire()){console.log('[monitor] another instance is active');process.exit(0);}
process.on('exit',()=>{try{if(fs.readFileSync(lock,'utf8')===String(process.pid))fs.unlinkSync(lock);}catch{}});
let total=100;
try{const n=JSON.parse(fs.readFileSync(path.join(here,'config.json'))).dailyTotal;if(validTotal(n))total=n;}catch{}
try{
  const r=await fetch('https://raw.githubusercontent.com/AryanSudhirDev/promptr-install-smoke-tests/main/monitor-config.json?t='+Date.now(),{signal:AbortSignal.timeout(15000),headers:{'Cache-Control':'no-cache'}});
  if(!r.ok)throw new Error('HTTP '+r.status);const n=(await r.json()).imacDailyTotal;if(!validTotal(n))throw new Error('invalid total');
  total=n;atomic(path.join(here,'config.json'),{dailyTotal:n,source:'repo',at:new Date().toISOString()});
}catch(e){console.log('[monitor] remote config unavailable; using local '+total+': '+e.message);}
if(process.env.DAILY_TOTAL){const n=Number(process.env.DAILY_TOTAL);if(!validTotal(n))throw new Error('invalid DAILY_TOTAL');total=n;}
const now=Date.now(),state=fs.existsSync(stateFile)?JSON.parse(fs.readFileSync(stateFile)):initialState(now,total);
const persist=()=>atomic(stateFile,state);
advance(state,now,total);persist();
const statusFile=path.join(here,'status-v2.json');
function blocked(reason){const status={at:new Date().toISOString(),schedulerVersion:2,dailyTotal:total,slotsPerDay:288,phase:'blocked',error:reason,pending:pendingJobs(state,10000).length};atomic(statusFile,status);console.error('[monitor] '+JSON.stringify(status));}
async function removeContainer(name){
  try{await exec('docker',['rm','-f',name],{timeout:20000});}
  catch(e){if(!/No such (container|object)/i.test(e.stderr||''))throw e;}
}
// Read the latest rate before checking Docker, so an unavailable engine cannot hide config changes.
try{
  try{await exec('docker',['info','--format','{{.NCPU}}'],{timeout:10000});}
  catch{await exec('colima',['start','--vm-type','vz','--cpu','4','--memory','6','--disk','10'],{timeout:120000});
    await exec('docker',['info','--format','{{.NCPU}}'],{timeout:10000});}
}catch(e){blocked('Docker unavailable: '+e.message);process.exit(1);}
// Finish interrupted/failed cleanup before permitting any new work.
for(const job of Object.values(state.jobs).filter(j=>j.status==='started'||j.status==='cleanup_pending')){
  try{await removeContainer('promptr-check-'+job.id);}
  catch(e){job.status='cleanup_pending';persist();blocked('Container cleanup unavailable: '+e.message);process.exit(1);}
  job.status='interrupted';job.finishedAt=new Date().toISOString();persist();
}
const concurrency=3,maxPerRun=process.env.MAX_JOBS_PER_RUN?Number(process.env.MAX_JOBS_PER_RUN):100,timeBudget=20*60000;
if(!Number.isInteger(maxPerRun)||maxPerRun<1||maxPerRun>100)throw new Error('invalid MAX_JOBS_PER_RUN');
let cleanupBlocked=false;
const due=pendingJobs(state,maxPerRun),queue=[...due],results=[];
console.log(`[monitor] ${new Date().toISOString()} configured=${total}/day slots=288/day pending=${pendingJobs(state,10000).length} batch=${due.length} concurrency=${concurrency}`);
const variants=['manifest','clean-state','settings-isolation','ui-settings','reinstall','duplicate-install'];
const started=Date.now();
function publish(phase='running'){const summary={at:new Date().toISOString(),schedulerVersion:2,dailyTotal:total,slotsPerDay:288,phase,selected:due.length,due:results.length,passed:results.filter(j=>j.status==='passed').length,failed:results.filter(j=>j.status==='failed'||j.status==='cleanup_pending').length,pending:pendingJobs(state,10000).length,missedSlots:state.missedSlots,expired:Object.values(state.jobs).filter(j=>j.status==='expired').length,interrupted:Object.values(state.jobs).filter(j=>j.status==='interrupted').length,slots:[...new Set(results.map(j=>new Date(j.slot).toISOString()))]};atomic(statusFile,summary);return summary;}
publish();
async function run(job){
  const out=path.join(here,'reports',job.id);fs.mkdirSync(out,{recursive:true});
  const variant=variants[(Math.floor(job.slot/300000)+job.index)%variants.length];
  job.status='started';job.startedAt=new Date().toISOString();persist();
  const begin=Date.now(),name='promptr-check-'+job.id;
  try{
    const r=await exec('docker',['run','--rm','--name',name,'--memory','2g','--shm-size','512m',
      '-e','TEST_VARIANT='+variant,'-e','TEST_RUN='+job.id,'-e','DAILY_PLAN_DATE='+new Date(job.slot).toISOString().slice(0,10),
      '-v',out+':/opt/check/results','-v',path.join(here,'extended-suite.cjs')+':/opt/check/extended-suite.cjs:ro',process.env.MONITOR_IMAGE||'promptr-install-check:local'],{timeout:5*60000});
    fs.writeFileSync(path.join(out,'container.log'),r.stdout+'\n--- stderr ---\n'+r.stderr);
    // Exit zero alone is insufficient: require the actual extension-test success marker.
    if(!r.stdout.includes('PROMPTR_EXTENDED_SMOKE_TEST_PASSED'))throw new Error('test success marker missing');
    job.status='passed';
  }catch(e){
    job.status='failed';job.error=String(e.message).slice(0,200);
    if(e.stdout||e.stderr)fs.writeFileSync(path.join(out,'container.log'),(e.stdout||'')+'\n--- stderr ---\n'+(e.stderr||''));
    try{await removeContainer(name);}catch(cleanupError){cleanupBlocked=true;job.status='cleanup_pending';job.cleanupError=cleanupError.message;}
  }
  job.seconds=Math.round((Date.now()-begin)/100)/10;job.finishedAt=new Date().toISOString();persist();results.push(job);publish(cleanupBlocked?'blocked':'running');
  console.log(`[monitor] ${job.id} ${variant}: ${job.status} in ${job.seconds}s`);
}
await Promise.all(Array.from({length:concurrency},async()=>{while(!cleanupBlocked&&queue.length&&Date.now()-started<timeBudget)await run(queue.shift());}));
const summary=publish(cleanupBlocked?'blocked':'idle');
fs.appendFileSync(path.join(here,'history.jsonl'),JSON.stringify(summary)+'\n');
atomic(path.join(here,'status-v2.json'),summary);console.log('[monitor] '+JSON.stringify(summary));
process.exitCode=summary.failed||cleanupBlocked?1:0;
