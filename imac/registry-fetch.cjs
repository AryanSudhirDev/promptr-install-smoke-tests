const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {setTimeout: sleep} = require('node:timers/promises');
const SPACING_MS = 650; // Per-stream gap after the response body, not just after dispatch.
const STREAM_COUNT = 2; // Owner-set: two overlapping Open VSX streams.
const TARGET_RPS = 2.5; // Owner-set fleet cap, still under the published community <3 rps ceiling.
const GLOBAL_START_SPACING_MS = Math.ceil(1000 / TARGET_RPS);
const SERVICE_ORDER=Object.freeze(['macbook','macbook','macbook','imac']);
function chooseRegistryTicket(waiting,turn=0){
 if(!Number.isInteger(turn)||turn<0||turn>=SERVICE_ORDER.length)throw new Error('Invalid registry service turn');
 for(let offset=0;offset<SERVICE_ORDER.length;offset++){const index=(turn+offset)%SERVICE_ORDER.length,ticket=waiting.find(x=>x.clientClass===SERVICE_ORDER[index]);if(ticket)return {...ticket,turn:index};}
 return null;
}
const HOSTS = new Set(['open-vsx.org', 'openvsx.eclipsecontent.org']);
class CooldownError extends Error { constructor(until) { super(`PROMPTR_REGISTRY_COOLDOWN until=${new Date(until).toISOString()}`); this.code='REGISTRY_COOLDOWN'; this.until=until; } }
function validateUrl(input) {
  const u=new URL(input);
  if(u.protocol!=='https:'||u.username||u.password||!HOSTS.has(u.host))throw new Error('Unexpected registry URL; refusing an unpaced or untrusted destination');
  return u.href;
}
function streamLock(dir,i){return path.join(dir,'lock-'+i);}
function assignmentLock(dir){return path.join(dir,'assign');}
function persistLock(dir){return path.join(dir,'persist');}
function clearLimiterLocks(dir){
 fs.rmSync(path.join(dir,'lock'),{recursive:true,force:true});
 fs.rmSync(assignmentLock(dir),{recursive:true,force:true});
 fs.rmSync(persistLock(dir),{recursive:true,force:true});
 for(let i=0;i<STREAM_COUNT;i++)fs.rmSync(streamLock(dir,i),{recursive:true,force:true});
 try{
  for(const name of fs.readdirSync(dir)){
   if(name==='state.json.tmp'||name.startsWith('state.json.tmp.'))fs.rmSync(path.join(dir,name),{force:true});
  }
 }catch(error){if(error.code!=='ENOENT')throw error;}
}
function validTurn(value){return value===undefined||(Number.isInteger(value)&&value>=0&&value<SERVICE_ORDER.length);}
function normalizeState(raw){
 if(!raw||typeof raw!=='object'||Array.isArray(raw)||![raw.cooldownUntil].every(n=>Number.isFinite(n)&&n>=0)||!validTurn(raw.priorityTurn))throw new Error('Invalid registry limiter state; refusing requests');
 if(raw.version===1){
  if(!Number.isFinite(raw.nextAllowedAt)||raw.nextAllowedAt<0)throw new Error('Invalid registry limiter state; refusing requests');
  return {
   version:2,nextStartAt:raw.nextAllowedAt,nextAllowedAt:raw.nextAllowedAt,cooldownUntil:raw.cooldownUntil,priorityTurn:raw.priorityTurn??0,
   streams:Array.from({length:STREAM_COUNT},()=>({nextAllowedAt:raw.nextAllowedAt})),
  };
 }
 if(raw.version!==2||!Number.isFinite(raw.nextStartAt)||raw.nextStartAt<0||!Array.isArray(raw.streams)||raw.streams.length!==STREAM_COUNT)throw new Error('Invalid registry limiter state; refusing requests');
 const streams=raw.streams.map(stream=>{
  if(!stream||!Number.isFinite(stream.nextAllowedAt)||stream.nextAllowedAt<0)throw new Error('Invalid registry limiter state; refusing requests');
  return {nextAllowedAt:stream.nextAllowedAt};
 });
 const nextAllowedAt=streams.reduce((min,stream)=>Math.min(min,stream.nextAllowedAt),streams[0].nextAllowedAt);
 return {version:2,nextStartAt:raw.nextStartAt,nextAllowedAt,cooldownUntil:raw.cooldownUntil,priorityTurn:raw.priorityTurn??0,streams};
}
function readState(dir) {
  return normalizeState(JSON.parse(fs.readFileSync(path.join(dir,'state.json'),'utf8')));
}
function writeState(dir,s) {
  const normalized=normalizeState(s);
  const tmp=path.join(dir,'state.json.tmp.'+crypto.randomUUID());
  fs.writeFileSync(tmp,JSON.stringify(normalized)+'\n',{mode:0o644});
  try{fs.renameSync(tmp,path.join(dir,'state.json'));}
  catch(error){try{fs.unlinkSync(tmp);}catch{/* keep the original rename error */}throw error;}
}
async function updateState(dir,deadline,mutator){
  while(Date.now()<deadline){
    try{fs.mkdirSync(persistLock(dir));}
    catch(error){if(error.code!=='EEXIST')throw error;await sleep(10);continue;}
    try{
      const next=mutator(readState(dir));
      if(next!==false)writeState(dir,next);
      return next;
    }finally{fs.rmSync(persistLock(dir),{recursive:true,force:true});}
  }
  throw new Error('Registry limiter lock deadline exceeded; failing closed');
}
function retryDelay(value,attempt,now=Date.now(),random=Math.random) {
  let delay;
  if(value&&/^\d+(\.\d+)?$/.test(value.trim()))delay=Number(value)*1000;
  else if(value){const date=Date.parse(value);if(Number.isFinite(date))delay=Math.max(0,date-now);}
  if(!Number.isFinite(delay))delay=2000*2**attempt;
  // Positive-only jitter never shortens Retry-After. Do not cap a server's long delay.
  return Math.max(SPACING_MS,delay)+250+Math.floor(random()*250);
}
function earliestStreamReady(state){return state.streams.reduce((min,stream)=>Math.min(min,stream.nextAllowedAt),state.streams[0].nextAllowedAt);}
async function acquire(dir,deadline,runId,clientClass) {
  const queue=path.join(dir,'queue'),token=crypto.randomUUID();
  fs.mkdirSync(queue,{recursive:true});
  const ticket=String(Date.now()).padStart(16,'0')+'-'+token+'.json',ticketPath=path.join(queue,ticket),temporary=ticketPath+'.tmp';
  fs.writeFileSync(temporary,JSON.stringify({deadline,clientClass}),{flag:'wx',mode:0o644});fs.renameSync(temporary,ticketPath);
  const readWaiting=()=>{
    const waiting=[];
    for(const name of fs.readdirSync(queue).sort()){
      if(name.endsWith('.tmp'))continue;
      if(!/^\d{16}-[a-f0-9-]+\.json$/.test(name))throw new Error('Invalid registry queue ticket; failing closed');
      const file=path.join(queue,name);let value;
      try{value=JSON.parse(fs.readFileSync(file,'utf8'));}catch(error){if(error.code==='ENOENT')continue;throw error;}
      if(!Number.isFinite(value.deadline)||!['imac','macbook'].includes(value.clientClass??'imac'))throw new Error('Invalid registry queue data; failing closed');
      if(value.deadline<=Date.now()){try{fs.unlinkSync(file);}catch(error){if(error.code!=='ENOENT')throw error;}continue;}
      waiting.push({name,clientClass:value.clientClass??'imac'});
    }
    return waiting;
  };
  try {
    while(Date.now()<deadline){
      const state=readState(dir);
      if(state.cooldownUntil>=deadline)throw new CooldownError(state.cooldownUntil);
      if(Date.now()<state.cooldownUntil){await sleep(Math.min(50,Math.max(1,deadline-Date.now())));continue;}
      if(chooseRegistryTicket(readWaiting(),state.priorityTurn)?.name!==ticket){await sleep(25);continue;}
      const ready=Math.max(state.nextStartAt,state.cooldownUntil,earliestStreamReady(state));
      if(Date.now()<ready){await sleep(Math.min(50,Math.max(1,Math.min(deadline,ready)-Date.now())));continue;}
      try{fs.mkdirSync(assignmentLock(dir));}catch(error){if(error.code!=='EEXIST')throw error;await sleep(25);continue;}
      let heldStream=-1,selected;
      try{
        const current=readState(dir);
        if(current.cooldownUntil>Date.now())continue;
        selected=chooseRegistryTicket(readWaiting(),current.priorityTurn);
        if(selected?.name!==ticket||Date.now()<current.nextStartAt)continue;
        for(let i=0;i<STREAM_COUNT;i++){
          if(current.streams[i].nextAllowedAt>Date.now())continue;
          try{fs.mkdirSync(streamLock(dir,i));}catch(error){if(error.code!=='EEXIST')throw error;continue;}
          const owner=path.join(streamLock(dir,i),'owner.json');
          try{fs.writeFileSync(owner,JSON.stringify({runId,pid:process.pid,at:Date.now(),token,stream:i}),{flag:'wx'});}
          catch(error){fs.rmSync(streamLock(dir,i),{recursive:true,force:true});throw new Error('Registry lock ownership could not be established; failing closed',{cause:error});}
          heldStream=i;break;
        }
        if(heldStream<0)continue;
        let grantedAt;
        await updateState(dir,deadline,s=>{grantedAt=Date.now();s.nextStartAt=grantedAt+GLOBAL_START_SPACING_MS;return s;});
        const stream=heldStream,turn=selected.turn,owner=path.join(streamLock(dir,stream),'owner.json');
        heldStream=-1;
        return {stream,turn,grantedAt,release:()=>{
          const observed=JSON.parse(fs.readFileSync(owner,'utf8'));
          if(observed.token!==token)throw new Error('Registry lock ownership changed; refusing to release another request');
          fs.unlinkSync(owner);fs.rmdirSync(streamLock(dir,stream));
        }};
      }finally{
        if(heldStream>=0)fs.rmSync(streamLock(dir,heldStream),{recursive:true,force:true});
        fs.rmSync(assignmentLock(dir),{recursive:true,force:true});
      }
    }
    throw new Error('Registry limiter lock deadline exceeded; failing closed');
  }finally{try{fs.unlinkSync(ticketPath);}catch(error){if(error.code!=='ENOENT')throw error;}}
}
function createRegistryFetch({stateDir,reportDir,runId='unknown',fetchImpl=fetch,totalTimeoutMs=120000,requestTimeoutMs=30000,maxAttempts=3,overallDeadline=Infinity,clientClass='imac'}={}) {
  if(!stateDir)throw new Error('Shared registry limiter directory is required');
  if(!['imac','macbook'].includes(clientClass))throw new Error('Invalid registry client class');
  if(!Number.isInteger(maxAttempts)||maxAttempts<1||maxAttempts>3)throw new Error('Invalid retry limit');
  return async function registryFetch(input) {
    let url=validateUrl(input),redirects=0,attempt=0;
    const deadline=Math.min(Date.now()+totalTimeoutMs,overallDeadline);
    while(true){
      const {release,turn,stream,grantedAt}=await acquire(stateDir,deadline,runId,clientClass);
      let response,body,retry=false;
      try{
        const s=readState(stateDir);
        if(s.cooldownUntil>=deadline)throw new CooldownError(s.cooldownUntil);
        while(Date.now()<s.cooldownUntil)await sleep(Math.min(1000,s.cooldownUntil-Date.now()));
        if(Date.now()>=deadline)throw new Error('Registry request deadline exceeded');
        const startedAt=grantedAt;let requestError;
        try{
          // Deliberately no Cache-Control: no-cache. That header forced every request past Fastly to
          // the origin, which answered 503 for 5 of 8 paired probes against 1 of 8 without it
          // (2026-09-16), and each 503 arms a 30 s fleet-wide cooldown. A check stays a real fresh
          // download: the bytes cross the network and are verified against the published SHA-256.
          response=await fetchImpl(url,{redirect:'manual',signal:AbortSignal.timeout(Math.max(1,Math.min(requestTimeoutMs,deadline-Date.now())))});
          const chunks=[];let bytes=0;
          if(response.body){for await(const chunk of response.body){bytes+=chunk.length;if(bytes>32*1024*1024)throw new Error('Registry response exceeds 32 MiB limit');chunks.push(Buffer.from(chunk));}}
          body=Buffer.concat(chunks);
        }catch(e){requestError=e;}
        const finishedAt=Date.now();
        if(response&&[429,503].includes(response.status))retry=attempt+1<maxAttempts;
        const persisted=await updateState(stateDir,Math.max(deadline,Date.now()+2000),current=>{
          current.streams[stream].nextAllowedAt=finishedAt+SPACING_MS;
          current.priorityTurn=(turn+1)%SERVICE_ORDER.length;
          if(response&&[429,503].includes(response.status)){
            current.cooldownUntil=Math.max(current.cooldownUntil,finishedAt+retryDelay(response.headers.get('retry-after'),attempt,finishedAt));
          }
          return current;
        });
        if(reportDir)fs.appendFileSync(path.join(reportDir,'registry-requests.jsonl'),JSON.stringify({runId,clientClass,stream,url,startedAt,finishedAt,status:response?.status??null,error:requestError?.message,attempt:attempt+1,cooldownUntil:persisted.cooldownUntil})+'\n');
        if(requestError)throw requestError;
        if(response&&[429,503].includes(response.status)&&persisted.cooldownUntil>=deadline)throw new CooldownError(persisted.cooldownUntil);
      }finally{release();}
      if(retry){attempt++;continue;}
      if([301,302,303,307,308].includes(response.status)){
        if(++redirects>5)throw new Error('Too many registry redirects');
        const location=response.headers.get('location');if(!location)throw new Error('Registry redirect without Location');
        url=validateUrl(new URL(location,url));continue;
      }
      return new Response([204,205,304].includes(response.status)?null:body,{status:response.status,headers:response.headers});
    }
  };
}
function initializeLimiter(dir,{containersAbsent=false}={}) {
  if(!containersAbsent)throw new Error('Must verify QA containers are absent before limiter recovery');
  fs.mkdirSync(dir,{recursive:true});
  if(!fs.existsSync(path.join(dir,'state.json')))writeState(dir,{version:2,nextStartAt:Date.now()+SPACING_MS,nextAllowedAt:Date.now()+SPACING_MS,cooldownUntil:0,priorityTurn:0,streams:Array.from({length:STREAM_COUNT},()=>({nextAllowedAt:Date.now()+SPACING_MS}))});
  const s=readState(dir);
  clearLimiterLocks(dir);
  const paused=Math.max(s.nextStartAt,Date.now()+SPACING_MS);
  s.nextStartAt=paused;
  s.streams=s.streams.map(stream=>({nextAllowedAt:Math.max(stream.nextAllowedAt,paused)}));
  writeState(dir,s);
  return s;
}
module.exports={chooseRegistryTicket,createRegistryFetch,initializeLimiter,readState,retryDelay,CooldownError,SPACING_MS,STREAM_COUNT,TARGET_RPS,GLOBAL_START_SPACING_MS};
