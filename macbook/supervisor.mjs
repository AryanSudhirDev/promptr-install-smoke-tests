import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {DEFAULT_SETTINGS,validateSettings} from './policy.mjs';
import {ROOT,DOCKER,atomic,eligibility} from './runtime.mjs';
import {run} from './exec.mjs';
import {acquireLocalLock} from './pid-lock.mjs';
import {
 DAY_WORKERS,OVERNIGHT_HOURS_DEFAULT,OVERNIGHT_MAX_WORKERS,RECOMMENDED_DOCKER_GIB,SUSTAINED_HOURS,applyOvernight,dockerGiB,
 hoursUntilMorningEnd,localStatusAllowed,overnightClaimPlan,overnightNightChecks,parseOvernightInput,readOvernight,
 shouldSustain,sustainedNeedsRenewal,workerCount,
} from './overnight.mjs';
import {applyDockerMemorySetting,DOCKER_MEMORY_MIB} from './docker-memory.mjs';
const API='https://promptr-qa-dashboard.vercel.app/api/macbook';
const STATUS_PORT=47831;
fs.mkdirSync(ROOT,{recursive:true,mode:0o700});
let settings={...DEFAULT_SETTINGS},current={phase:'starting',eligible:false,reasons:['settings_unavailable']},worker=null,caffeine=null,closing=false,timer;
const lock=path.join(ROOT,'supervisor.pid');
const releaseLock=await acquireLocalLock(lock,fileURLToPath(import.meta.url));if(!releaseLock)process.exit(0);
function readWorker(){try{return JSON.parse(fs.readFileSync(path.join(ROOT,'worker-status.json'),'utf8'));}catch{return null;}}
async function dockerMemoryBytes(){
 try{return Number((await run(DOCKER,['info','--format','{{.MemTotal}}'],{timeout:5000})).stdout.trim())||0;}catch{return 0;}
}
function snapshot(){
 const overnight=readOvernight(ROOT),mem=current.dockerMemBytes||0;
 const plan=overnightClaimPlan(settings,{overnight,memTotalBytes:mem});
 const fullNight=overnightNightChecks({workers:OVERNIGHT_MAX_WORKERS,hours:OVERNIGHT_HOURS_DEFAULT});
 return {
  ...current,settings,worker:worker?readWorker():null,workerPid:worker?.pid||null,
  overnight,dockerGiB:dockerGiB(mem),workerCount:workerCount({memTotalBytes:mem,overnight:Boolean(overnight)}),
  dayWorkers:DAY_WORKERS,overnightMaxWorkers:OVERNIGHT_MAX_WORKERS,recommendedDockerGiB:RECOMMENDED_DOCKER_GIB,
  nightChecks:plan.nightChecks||null,nightPerHour:plan.perHour||null,nightComputePerHour:plan.computePerHour||null,
  promptrNightChecks:plan.promptrNightChecks||null,cognispecNightChecks:plan.cognispecNightChecks||null,
  fullNightChecks:fullNight.nightChecks,fullNightPerHour:fullNight.perHour,fullNightComputePerHour:fullNight.computePerHour,
  privacy:'Local-only device status. No battery or home-presence telemetry is published.',
 };
}
function save(){atomic(path.join(ROOT,'status.json'),snapshot());}
let restartTimer;
function scheduleWorkerRestart(){
 if(closing||worker||!current.eligible)return;
 clearTimeout(restartTimer);
 restartTimer=setTimeout(()=>{if(!closing&&!worker&&current.eligible)startWorker();},3000);
 restartTimer.unref?.();
}
function startWorker(){
 if(worker||!current.eligible)return;
 worker=spawn(process.execPath,[fileURLToPath(new URL('./worker.mjs',import.meta.url))],{env:process.env,stdio:['ignore','inherit','inherit']});
 worker.on('error',()=>{worker=null;current.phase='worker_start_failed';save();if(!closing)scheduleWorkerRestart();});
 worker.on('exit',()=>{worker=null;if(!closing){save();scheduleWorkerRestart();}});
}
function stopWorker({removeContainers=true}={}){
 if(worker){const w=worker;w.kill('SIGTERM');const hard=setTimeout(()=>{if(worker===w)w.kill('SIGKILL');},25000);hard.unref();}
 if(!removeContainers)return;
 setTimeout(async()=>{try{const rows=await run(DOCKER,['ps','-aq','--filter','label=qa.macbook.runner=promptr-qa'],{timeout:8000});const ids=rows.stdout.trim().split(/\s+/).filter(Boolean);if(ids.length&&ids.every(id=>/^[a-f0-9]+$/.test(id)))await run(DOCKER,['rm','-f',...ids],{timeout:15000});}catch{}},2000);
}
function restartWorker(){
 return new Promise(resolve=>{
  if(!worker){resolve();return;}
  const w=worker;
  w.once('exit',()=>resolve());
  w.kill('SIGTERM');
  const hard=setTimeout(()=>{if(worker===w)w.kill('SIGKILL');},25000);hard.unref();
 });
}
function manageCaffeine(home){const want=settings.enabled&&current.power?.onAC&&(!settings.requireHome||home)&&!closing;if(want&&!caffeine){caffeine=spawn('/usr/bin/caffeinate',['-s','-w',String(process.pid)],{stdio:'ignore'});caffeine.on('error',()=>{caffeine=null;});caffeine.on('exit',()=>{caffeine=null;});}else if(!want&&caffeine){caffeine.kill();caffeine=null;}}
// Keeps the high-concurrency window alive all day while the laptop is at home on acceptable
// power, and takes it away once either condition goes, so leaving the house drops to
// DAY_WORKERS instead of holding eleven lanes until the window would have expired. Either
// direction restarts the worker, because a lane count is fixed when the worker starts;
// renewing a window that is already active changes nothing and stays silent.
async function maintainSustainedWindow(gate){
 const active=readOvernight(ROOT);
 if(!shouldSustain({settings,power:gate.power,home:gate.home})){
  if(!active)return;
  applyOvernight(ROOT,{stop:true});
  await restartWorker();
  return;
 }
 if(!sustainedNeedsRenewal(active))return;
 applyOvernight(ROOT,{hours:SUSTAINED_HOURS});
 if(active)return;
 await applyOvernightDockerMemory();
 await restartWorker();
}
async function tick(){
 if(closing)return;
 let fresh=false,error=null;
 try{const response=await fetch(API,{cache:'no-store',signal:AbortSignal.timeout(12000)});if(!response.ok)throw new Error('Settings service unavailable');const body=await response.json();settings=validateSettings(body.settings);fresh=true;}catch{error='Cannot confirm current dashboard settings; paused safely.';}
 try{
  const g=await eligibility(settings,{configFresh:fresh}),dockerMemBytes=await dockerMemoryBytes();
  current={...g,phase:g.eligible?'eligible':'paused',at:new Date().toISOString(),settingsConfirmed:fresh,error,dockerMemBytes,nextCheckAt:new Date(Date.now()+settings.pollIntervalMinutes*60000).toISOString()};
  atomic(path.join(ROOT,'runtime.json'),{settings,configFresh:fresh,updatedAt:current.at,eligible:g.eligible});manageCaffeine(g.home);
  if(g.eligible)await maintainSustainedWindow(g);
  if(g.eligible)startWorker();else stopWorker();save();console.log(JSON.stringify({at:current.at,phase:current.phase,reasons:current.reasons,overnight:Boolean(readOvernight(ROOT)),workerCount:snapshot().workerCount}));
 }catch{current={phase:'paused',eligible:false,reasons:['local_health_check_failed'],at:new Date().toISOString()};atomic(path.join(ROOT,'runtime.json'),{settings,configFresh:false,updatedAt:current.at,eligible:false});stopWorker();save();}
 clearTimeout(timer);timer=setTimeout(tick,settings.pollIntervalMinutes*60000);
}
async function waitForDockerMemory(minBytes,deadline=Date.now()+90000){
 while(Date.now()<deadline){
  const mem=await dockerMemoryBytes();
  if(mem>=minBytes)return mem;
  await new Promise(resolve=>setTimeout(resolve,2000));
 }
 return dockerMemoryBytes();
}
async function applyOvernightDockerMemory(){
 let result={changed:false,memoryMiB:DOCKER_MEMORY_MIB};
 try{result=applyDockerMemorySetting();}catch{}
 if(result.changed){
  try{await run(DOCKER,['desktop','restart'],{timeout:120000});}catch{
   try{await run(DOCKER,['desktop','stop'],{timeout:30000});}catch{}
   await run('/usr/bin/open',['-gj','/Applications/Docker.app'],{timeout:10000});
  }
  await waitForDockerMemory(result.memoryMiB*1024*1024*0.9);
 }
 current.dockerMemBytes=await dockerMemoryBytes();
 return result;
}
function readRequestBody(req,limit=4096){
 return new Promise((resolve,reject)=>{
  const chunks=[];let n=0;
  req.on('data',c=>{n+=c.length;if(n>limit){req.destroy();reject(new Error('too large'));return;}chunks.push(c);});
  req.on('end',()=>resolve(Buffer.concat(chunks).toString('utf8')));
  req.on('error',reject);
 });
}
function overnightCopy(s){
 if(s.overnight){
  const hoursLeft=Math.max(0,(Date.parse(s.overnight.until)-Date.now())/3600000);
  const volume=s.nightChecks?` About ${s.nightChecks.toLocaleString('en-US')} checks over ${s.overnight.hours} h (${(s.promptrNightChecks||0).toLocaleString('en-US')} Promptr, ${(s.cognispecNightChecks||0).toLocaleString('en-US')} CogniSpec, ~${s.nightPerHour}/hour), using ${s.workerCount} concurrent slots.`:'';
  return `Overnight is on until ${s.overnight.until.replace('T',' ').replace(/\.\d+Z$/,' UTC')} (${hoursLeft.toFixed(1)} h left).${volume}`;
 }
 return `High concurrency runs all day while this Mac is on the home network and either plugged in or above ${settings.minBatteryPercent}% battery; it drops to ${s.dayWorkers} concurrent checks otherwise. An 8-hour stretch at ${s.recommendedDockerGiB} GiB is about ${s.fullNightChecks.toLocaleString('en-US')} checks (~${s.fullNightPerHour}/hour) across ${s.overnightMaxWorkers} slots. RAM could compute ~${s.fullNightComputePerHour}/hour; Open VSX pacing is the slower part.`;
}
function dockerCopy(s){
 const have=s.dockerGiB==null?'unknown':`${s.dockerGiB} GiB`;
 const overnightWorkers=workerCount({memTotalBytes:current.dockerMemBytes||0,overnight:true});
 if(overnightWorkers>s.dayWorkers)return `Docker memory is ${have}, enough for ${overnightWorkers} overnight checks (${overnightWorkers*2} GiB of 2 GiB containers, plus swap).`;
 return `Docker memory is ${have}. Overnight start will try to give Docker ${s.recommendedDockerGiB} GiB; until then it stays at ${s.dayWorkers} checks.`;
}
const escape=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const server=http.createServer(async(req,res)=>{
 if(!localStatusAllowed({host:req.headers.host,origin:req.headers.origin,port:STATUS_PORT})){res.writeHead(403);return res.end('Local navigation only');}
 if(req.method==='POST'&&req.url==='/overnight'){
  try{
   const action=parseOvernightInput(await readRequestBody(req),req.headers['content-type']);
   applyOvernight(ROOT,action);
   if(!action.stop)await applyOvernightDockerMemory();
   await restartWorker();
   startWorker();
   save();
   res.writeHead(303,{Location:'/','Cache-Control':'no-store'});
   return res.end();
  }catch{res.writeHead(400);return res.end('Invalid overnight request');}
 }
 if(req.method!=='GET'||!['/','/status.json'].includes(req.url)){res.writeHead(404);return res.end('Not found');}
 const s=snapshot();res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('X-Frame-Options','DENY');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('Content-Security-Policy',"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
 if(req.url==='/status.json'){res.setHeader('Content-Type','application/json');return res.end(JSON.stringify(s,null,2));}
 res.setHeader('Content-Type','text/html; charset=utf-8');res.end(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="15"><title>MacBook runner | Local status</title><style>:root{color-scheme:light dark}body{font:16px/1.65 system-ui;max-width:750px;margin:6vh auto;padding:24px}h1{letter-spacing:-.04em}section{border:1px solid #8886;border-radius:14px;padding:24px;margin:20px 0}dt{opacity:.7}dd{margin:0 0 12px;font-weight:600}a{color:inherit}code{font-size:13px}form{display:flex;flex-wrap:wrap;gap:10px;margin-top:12px}button{font:inherit;min-height:40px;padding:8px 14px;border:1px solid #8886;border-radius:9px;background:transparent;color:inherit;cursor:pointer}</style></head><body><a href="https://promptr-qa-dashboard.vercel.app/macbook">Back to MacBook settings</a><h1>MacBook runner</h1><p>Private status, served only on this Mac.</p><section><h2>${escape(s.worker?.phase||s.phase)}</h2><p>${escape(s.reasons?.length?s.reasons.join(', ').replaceAll('_',' '):'Eligible for independently planned MacBook checks.')}</p><dl><dt>Power</dt><dd>${s.power?.known?`${s.power.percent}% · ${s.power.onAC?'Plugged in':'Battery power'}`:'Unknown'}</dd><dt>Home check</dt><dd>${!settings.requireHome?'Not required by current settings':s.home?'Verified direct home connection':'Not verified'}</dd><dt>Concurrent checks</dt><dd>${escape(String(s.workerCount||DAY_WORKERS))}</dd><dt>Policy checked</dt><dd>${escape(s.at||'Starting')}</dd><dt>Next settings check</dt><dd>${escape(s.nextCheckAt||'Starting')}</dd><dt>Worker</dt><dd>${escape(s.worker?.detail||s.worker?.jobId||'No active check')}</dd></dl><p>${escape(s.error||s.worker?.error||'')}</p></section><section><h2>Going to sleep</h2><p>${escape(overnightCopy(s))}</p><p>${escape(dockerCopy(s))}</p><p>Plug in, stay logged in, and leave the lid open. Closing the lid sleeps this Mac and stops checks. Display sleep is fine. Overnight expires on its own and does not change the iMac.</p><form method="post" action="/overnight"><input type="hidden" name="hours" value="${hoursUntilMorningEnd()}"><button type="submit">I&rsquo;m going to sleep (until 7:50 AM)</button></form>${s.overnight?`<form method="post" action="/overnight"><input type="hidden" name="stop" value="1"><button type="submit">Stop overnight</button></form>`:''}</section><p>Starts above ${settings.minBatteryPercent}% battery. Settings refresh every ${settings.pollIntervalMinutes} minutes.</p><p>Automatic recovery works while logged in. Lid closure, manual sleep, shutdown, or lost connectivity can pause the runner. Only this runner’s containers are cleaned up.</p></body></html>`);
});
server.listen(STATUS_PORT,'127.0.0.1');server.on('error',()=>{console.error('Private status port unavailable');shutdown();});
function shutdown(){if(closing)return;closing=true;clearTimeout(timer);clearTimeout(restartTimer);stopWorker();if(caffeine)caffeine.kill();server.close();releaseLock();setTimeout(()=>process.exit(0),26000).unref();}
process.on('SIGTERM',shutdown);process.on('SIGINT',shutdown);
await tick();
