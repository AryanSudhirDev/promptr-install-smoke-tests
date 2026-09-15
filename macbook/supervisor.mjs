import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {DEFAULT_SETTINGS,validateSettings} from './policy.mjs';
import {ROOT,DOCKER,atomic,eligibility} from './runtime.mjs';
import {run} from './exec.mjs';
import {acquireLocalLock} from './pid-lock.mjs';
const API='https://promptr-qa-dashboard.vercel.app/api/macbook';
const STATUS_PORT=47831;
fs.mkdirSync(ROOT,{recursive:true,mode:0o700});
let settings={...DEFAULT_SETTINGS},current={phase:'starting',eligible:false,reasons:['settings_unavailable']},worker=null,caffeine=null,closing=false,timer;
const lock=path.join(ROOT,'supervisor.pid');
const releaseLock=await acquireLocalLock(lock,fileURLToPath(import.meta.url));if(!releaseLock)process.exit(0);
function readWorker(){try{return JSON.parse(fs.readFileSync(path.join(ROOT,'worker-status.json'),'utf8'));}catch{return null;}}
function snapshot(){return {...current,settings,worker:worker?readWorker():null,workerPid:worker?.pid||null,privacy:'Local-only device status. No battery or home-presence telemetry is published.'};}
function save(){atomic(path.join(ROOT,'status.json'),snapshot());}
function stopWorker(){
 if(worker){const w=worker;w.kill('SIGTERM');const hard=setTimeout(()=>{if(worker===w)w.kill('SIGKILL');},25000);hard.unref();}
 // Independent cleanup also covers an orphan container when no worker is running.
 // It never starts Docker and never removes an unlabeled user container.
 setTimeout(async()=>{try{const rows=await run(DOCKER,['ps','-aq','--filter','label=qa.macbook.runner=promptr-qa'],{timeout:8000});const ids=rows.stdout.trim().split(/\s+/).filter(Boolean);if(ids.length&&ids.every(id=>/^[a-f0-9]+$/.test(id)))await run(DOCKER,['rm','-f',...ids],{timeout:15000});}catch{}},2000);
}
function manageCaffeine(home){const want=settings.enabled&&current.power?.onAC&&(!settings.requireHome||home)&&!closing;if(want&&!caffeine){caffeine=spawn('/usr/bin/caffeinate',['-s','-w',String(process.pid)],{stdio:'ignore'});caffeine.on('error',()=>{caffeine=null;});caffeine.on('exit',()=>{caffeine=null;});}else if(!want&&caffeine){caffeine.kill();caffeine=null;}}
async function tick(){
 if(closing)return;
 let fresh=false,error=null;
 try{const response=await fetch(API,{cache:'no-store',signal:AbortSignal.timeout(12000)});if(!response.ok)throw new Error('Settings service unavailable');const body=await response.json();settings=validateSettings(body.settings);fresh=true;}catch{error='Cannot confirm current dashboard settings; paused safely.';}
 try{const g=await eligibility(settings,{configFresh:fresh});current={...g,phase:g.eligible?'eligible':'paused',at:new Date().toISOString(),settingsConfirmed:fresh,error,nextCheckAt:new Date(Date.now()+settings.pollIntervalMinutes*60000).toISOString()};atomic(path.join(ROOT,'runtime.json'),{settings,configFresh:fresh,updatedAt:current.at,eligible:g.eligible});manageCaffeine(g.home);
  if(g.eligible&&!worker){worker=spawn(process.execPath,[fileURLToPath(new URL('./worker.mjs',import.meta.url))],{env:process.env,stdio:['ignore','inherit','inherit']});worker.on('error',()=>{worker=null;current.phase='worker_start_failed';save();});worker.on('exit',()=>{worker=null;if(!closing)save();});}
  if(!g.eligible)stopWorker();save();console.log(JSON.stringify({at:current.at,phase:current.phase,reasons:current.reasons}));
 }catch{current={phase:'paused',eligible:false,reasons:['local_health_check_failed'],at:new Date().toISOString()};atomic(path.join(ROOT,'runtime.json'),{settings,configFresh:false,updatedAt:current.at,eligible:false});stopWorker();save();}
 clearTimeout(timer);timer=setTimeout(tick,settings.pollIntervalMinutes*60000);
}
const escape=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const server=http.createServer((req,res)=>{
 if(!['127.0.0.1:'+STATUS_PORT,'localhost:'+STATUS_PORT].includes(req.headers.host)||req.headers.origin){res.writeHead(403);return res.end('Local navigation only');}
 if(req.method!=='GET'||!['/','/status.json'].includes(req.url)){res.writeHead(404);return res.end('Not found');}
 const s=snapshot();res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('X-Frame-Options','DENY');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('Content-Security-Policy',"default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'");
 if(req.url==='/status.json'){res.setHeader('Content-Type','application/json');return res.end(JSON.stringify(s,null,2));}
 res.setHeader('Content-Type','text/html; charset=utf-8');res.end(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="15"><title>MacBook runner | Local status</title><style>:root{color-scheme:light dark}body{font:16px/1.65 system-ui;max-width:750px;margin:6vh auto;padding:24px}h1{letter-spacing:-.04em}section{border:1px solid #8886;border-radius:14px;padding:24px;margin:20px 0}dt{opacity:.7}dd{margin:0 0 12px;font-weight:600}a{color:inherit}code{font-size:13px}</style></head><body><a href="https://promptr-qa-dashboard.vercel.app/macbook">Back to MacBook settings</a><h1>MacBook runner</h1><p>Private status, served only on this Mac.</p><section><h2>${escape(s.worker?.phase||s.phase)}</h2><p>${escape(s.reasons?.length?s.reasons.join(', ').replaceAll('_',' '):'Eligible for the shared work queue.')}</p><dl><dt>Power</dt><dd>${s.power?.known?`${s.power.percent}% · ${s.power.onAC?'Plugged in':'Battery power'}`:'Unknown'}</dd><dt>Home check</dt><dd>${!settings.requireHome?'Not required by current settings':s.home?'Verified direct home connection':'Not verified'}</dd><dt>Policy checked</dt><dd>${escape(s.at||'Starting')}</dd><dt>Next settings check</dt><dd>${escape(s.nextCheckAt||'Starting')}</dd><dt>Worker</dt><dd>${escape(s.worker?.detail||s.worker?.jobId||'No active check')}</dd></dl><p>${escape(s.error||s.worker?.error||'')}</p></section><p>Starts above ${settings.minBatteryPercent}% battery. Settings refresh every ${settings.pollIntervalMinutes} minutes. One delegated check at a time, within the existing shared daily plan.</p><p>Automatic recovery works while logged in. Lid closure, manual sleep, shutdown, or lost connectivity can pause the runner. Only this runner’s containers are cleaned up.</p></body></html>`);
});
server.listen(STATUS_PORT,'127.0.0.1');server.on('error',()=>{console.error('Private status port unavailable');shutdown();});
function shutdown(){if(closing)return;closing=true;clearTimeout(timer);stopWorker();if(caffeine)caffeine.kill();server.close();releaseLock();setTimeout(()=>process.exit(0),26000).unref();}
process.on('SIGTERM',shutdown);process.on('SIGINT',shutdown);
await tick();
