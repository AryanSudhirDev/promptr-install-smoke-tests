import fs from 'node:fs';
import path from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import {run} from './exec.mjs';
import {ROOT,DOCKER,atomic,eligibility,workerStatus,broker} from './runtime.mjs';
import {ensureImage} from './image.mjs';
import {fileURLToPath} from 'node:url';
import {acquireLocalLock} from './pid-lock.mjs';
const abort=new AbortController();let activeName=null,lastSettings=null,cleanupVerified=false;
const lock=path.join(ROOT,'worker.pid');
const releaseLock=await acquireLocalLock(lock,fileURLToPath(import.meta.url));if(!releaseLock)process.exit(0);
process.on('SIGTERM',()=>abort.abort());process.on('SIGINT',()=>abort.abort());
async function allowed(){
 let runtime;try{runtime=JSON.parse(fs.readFileSync(path.join(ROOT,'runtime.json'),'utf8'));}catch{return false;}
 lastSettings=runtime.settings;const fresh=runtime.configFresh&&Date.now()-Date.parse(runtime.updatedAt)<(runtime.settings.pollIntervalMinutes*60+30)*1000;
 const g=await eligibility(runtime.settings,{configFresh:fresh});return g.eligible;
}
let checking=false;const guard=setInterval(async()=>{if(checking||abort.signal.aborted)return;checking=true;try{if(!await allowed())abort.abort();}catch{abort.abort();}finally{checking=false;}},15000);
async function cleanupAll(){
 const r=await run(DOCKER,['ps','-aq','--filter','label=qa.macbook.runner=promptr-qa'],{timeout:10000});const ids=r.stdout.trim().split(/\s+/).filter(Boolean);if(ids.some(id=>!/^\w+$/.test(id)))throw new Error('Unexpected Docker identity');
 if(ids.length)await run(DOCKER,['rm','-f',...ids],{timeout:20000});cleanupVerified=true;
}
async function complete(request,{deadline=Date.now()+120000}={}){
 while(Date.now()<deadline){try{return await broker('macbook-complete',request,{...lastSettings,requireHome:false},{timeout:20000});}catch(e){if(!['BUSY','LOCAL_ACTIVE'].includes(e.code))throw e;await sleep(3000);}}
 throw new Error('Broker busy; completion saved for recovery');
}
async function recover(){
 // Worker PID mutex excludes another live worker. Remove only our containers before
 // acknowledging abandoned leases, including leases lost before their bundle arrived.
 await cleanupAll();let state;
 for(let i=0;i<45;i++){try{state=await broker('macbook-recover',null,{...lastSettings,requireHome:false},{timeout:15000});break;}catch(e){if(e.code!=='BUSY')throw e;await sleep(3000);}}
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
async function check(bundle,image,started){
 if(!/^[A-Za-z0-9_-]{1,160}$/.test(bundle.jobId)||!['promptr','cognispec'].includes(bundle.target)||bundle.targetId!=='aryansudhir.'+bundle.target)throw new Error('Invalid leased job identity');
 const dir=path.join(ROOT,'jobs',bundle.jobId),results=path.join(dir,'results');fs.mkdirSync(results,{recursive:true,mode:0o700});const relayDir=path.join(dir,'relay');fs.mkdirSync(relayDir,{recursive:true,mode:0o700});const {leaseToken,...publicBundle}=bundle;atomic(path.join(relayDir,'bundle.json'),publicBundle);
 activeName='macbook-check-'+bundle.jobId;cleanupVerified=false;workerStatus({phase:'running_check',jobId:bundle.jobId,target:bundle.target,variant:bundle.variant});let success=false,error='';
 try{
  if(abort.signal.aborted||!await allowed())throw new Error('Eligibility changed before the check started');
  const r=await run(DOCKER,['run','--name',activeName,'--label','qa.macbook.runner=promptr-qa','--platform','linux/arm64','--network','none','--memory','2g','--memory-swap','2g','--cpus','2','--pids-limit','512','--shm-size','512m','-e','TARGET_EXTENSION='+bundle.targetId,'-e','TEST_RUN='+bundle.jobId,'-e','TEST_VARIANT='+bundle.variant,'-e','DAILY_PLAN_DATE='+bundle.downloadStart.slice(0,10),'-v',relayDir+':/relay:ro','-v',results+':/opt/check/results',image],{timeout:180000,signal:abort.signal,maxBuffer:8*1024*1024});fs.writeFileSync(path.join(results,'container.log'),r.stdout+r.stderr,{mode:0o600});success=true;
 }catch(e){error=abort.signal.aborted?'Eligibility changed or runner stopped':e.message;fs.writeFileSync(path.join(results,'container.log'),(e.stdout||'')+(e.stderr||'')+'\nRunner: '+error+'\n',{mode:0o600});}
 finally{
  try{await cleanupAll();activeName=null;}catch{error='Owned container cleanup is unconfirmed; shared slot remains fenced';success=false;}
  fs.rmSync(path.join(relayDir,'bundle.json'),{force:true});
 }
 const request={jobId:bundle.jobId,leaseToken,status:success?'passed':'failed',seconds:(Date.now()-started)/1000,reports:readReports(results),error,cleanupConfirmed:cleanupVerified};
 const receipt=path.join(ROOT,'outbox',bundle.jobId+'.json');atomic(receipt,request);
 if(!cleanupVerified)throw new Error(error);
 try{await complete(request);fs.unlinkSync(receipt);workerStatus({phase:'waiting_for_work',detail:'Last check '+request.status,jobId:bundle.jobId});}
 catch(e){workerStatus({phase:'completion_pending',detail:'Result saved locally; no new work until reconciliation.',error:e.message});throw e;}
}
function prune(){const jobs=path.join(ROOT,'jobs');if(!fs.existsSync(jobs))return;for(const name of fs.readdirSync(jobs)){const p=path.join(jobs,name),s=fs.lstatSync(p);if(s.isDirectory()&&!s.isSymbolicLink()&&Date.now()-s.mtimeMs>2*86400000)fs.rmSync(p,{recursive:true});}}
try{
 if(!await allowed())throw new Error('Not eligible');const image=await ensureImage(abort.signal);await recover();prune();workerStatus({phase:'waiting_for_work',detail:'Eligible; waiting for an already-planned shared check.'});
 while(!abort.signal.aborted){
  if(!await allowed())break;
  const plan={promptrDailyTotal:lastSettings.promptrDailyTotal,cognispecDailyTotal:lastSettings.cognispecDailyTotal};
  if(plan.promptrDailyTotal===0&&plan.cognispecDailyTotal===0){workerStatus({phase:'paused_plan',detail:'Both independently planned MacBook targets are set to 0/day.'});await sleep(15000,null,{signal:abort.signal});continue;}
  const peek=await broker('macbook-peek',{plan},lastSettings,{signal:abort.signal,timeout:15000});if(!peek.available){await sleep(15000,null,{signal:abort.signal});continue;}
  const start=Date.now();let bundle;try{bundle=await broker('macbook-claim',{plan},lastSettings,{signal:abort.signal,timeout:120000});}catch(e){if(['BUSY','LOCAL_ACTIVE','REMOTE_ACTIVE'].includes(e.code)){await sleep(5000,null,{signal:abort.signal});continue;}throw e;}
  if(!bundle.claimed){await sleep(15000,null,{signal:abort.signal});continue;}
  await check(bundle,image,start);
 }
}catch(e){workerStatus({phase:abort.signal.aborted?'paused':'needs_attention',detail:abort.signal.aborted?'Eligibility changed; stopping owned work.':e.message});console.error('MacBook worker:',abort.signal.aborted?'paused':e.message);}
finally{clearInterval(guard);if(activeName)try{await cleanupAll();}catch{}releaseLock();}
