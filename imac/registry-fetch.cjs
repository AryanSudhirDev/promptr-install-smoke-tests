const fs = require('node:fs');
const path = require('node:path');
const {setTimeout: sleep} = require('node:timers/promises');
const SPACING_MS = 650; // Always leave >500ms after completion, not just after dispatch.
const HOSTS = new Set(['open-vsx.org', 'openvsx.eclipsecontent.org']);
class CooldownError extends Error { constructor(until) { super(`PROMPTR_REGISTRY_COOLDOWN until=${new Date(until).toISOString()}`); this.code='REGISTRY_COOLDOWN'; this.until=until; } }
function validateUrl(input) {
  const u=new URL(input);
  if(u.protocol!=='https:'||u.username||u.password||!HOSTS.has(u.host))throw new Error('Unexpected registry URL; refusing an unpaced or untrusted destination');
  return u.href;
}
function readState(dir) {
  const s=JSON.parse(fs.readFileSync(path.join(dir,'state.json'),'utf8'));
  if(s.version!==1||![s.nextAllowedAt,s.cooldownUntil].every(n=>Number.isFinite(n)&&n>=0))throw new Error('Invalid registry limiter state; refusing requests');
  return s;
}
function writeState(dir,s) {
  const tmp=path.join(dir,'state.json.tmp');
  fs.writeFileSync(tmp,JSON.stringify(s)+'\n',{mode:0o644});fs.renameSync(tmp,path.join(dir,'state.json'));
}
function retryDelay(value,attempt,now=Date.now(),random=Math.random) {
  let delay;
  if(value&&/^\d+(\.\d+)?$/.test(value.trim()))delay=Number(value)*1000;
  else if(value){const date=Date.parse(value);if(Number.isFinite(date))delay=Math.max(0,date-now);}
  if(!Number.isFinite(delay))delay=2000*2**attempt;
  // Positive-only jitter never shortens Retry-After. Do not cap a server's long delay.
  return Math.max(SPACING_MS,delay)+250+Math.floor(random()*250);
}
async function acquire(dir,deadline,runId) {
  const lock=path.join(dir,'lock');
  while(Date.now()<deadline){
    try{fs.mkdirSync(lock);}
    catch(e){if(e.code!=='EEXIST')throw e;await sleep(Math.min(100,Math.max(1,deadline-Date.now())));continue;}
    try{fs.writeFileSync(path.join(lock,'owner.json'),JSON.stringify({runId,pid:process.pid,at:Date.now()}));}
    catch(e){fs.rmSync(lock,{recursive:true,force:true});throw e;}
    return ()=>fs.rmSync(lock,{recursive:true,force:true});
  }
  throw new Error('Registry limiter lock deadline exceeded; failing closed');
}
function createRegistryFetch({stateDir,reportDir,runId='unknown',fetchImpl=fetch,totalTimeoutMs=120000,requestTimeoutMs=30000,maxAttempts=3}={}) {
  if(!stateDir)throw new Error('Shared registry limiter directory is required');
  if(!Number.isInteger(maxAttempts)||maxAttempts<1||maxAttempts>3)throw new Error('Invalid retry limit');
  return async function registryFetch(input) {
    let url=validateUrl(input),redirects=0,attempt=0;
    const deadline=Date.now()+totalTimeoutMs;
    while(true){
      const release=await acquire(stateDir,deadline,runId);
      let response,body,retry=false;
      try{
        const s=readState(stateDir),ready=Math.max(s.nextAllowedAt,s.cooldownUntil);
        if(ready>=deadline){if(s.cooldownUntil>=deadline)throw new CooldownError(s.cooldownUntil);throw new Error('Registry pacing deadline exceeded');}
        while(Date.now()<ready)await sleep(Math.min(1000,ready-Date.now()));
        if(Date.now()>=deadline)throw new Error('Registry request deadline exceeded');
        const startedAt=Date.now();let requestError;
        try{
          response=await fetchImpl(url,{redirect:'manual',headers:{'Cache-Control':'no-cache'},signal:AbortSignal.timeout(Math.max(1,Math.min(requestTimeoutMs,deadline-Date.now())))});
          // Keep the lock and network timeout through the body; bound buffering as well.
          const chunks=[];let bytes=0;
          if(response.body){for await(const chunk of response.body){bytes+=chunk.length;if(bytes>32*1024*1024)throw new Error('Registry response exceeds 32 MiB limit');chunks.push(Buffer.from(chunk));}}
          body=Buffer.concat(chunks);
        }catch(e){requestError=e;}
        const finishedAt=Date.now();
        s.nextAllowedAt=finishedAt+SPACING_MS;
        if(response&&[429,503].includes(response.status)){
          s.cooldownUntil=Math.max(s.cooldownUntil,finishedAt+retryDelay(response.headers.get('retry-after'),attempt,finishedAt));
          retry=attempt+1<maxAttempts;
        }
        writeState(stateDir,s); // Persist before releasing lock, including errors and cooldowns.
        if(reportDir)fs.appendFileSync(path.join(reportDir,'registry-requests.jsonl'),JSON.stringify({runId,url,startedAt,finishedAt,status:response?.status??null,error:requestError?.message,attempt:attempt+1,cooldownUntil:s.cooldownUntil})+'\n');
        if(requestError)throw requestError;
        if(response&&[429,503].includes(response.status)&&s.cooldownUntil>=deadline)throw new CooldownError(s.cooldownUntil);
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
// Only the host monitor may call this, AFTER verifying all previous QA containers are gone.
function initializeLimiter(dir,{containersAbsent=false}={}) {
  if(!containersAbsent)throw new Error('Must verify QA containers are absent before limiter recovery');
  fs.mkdirSync(dir,{recursive:true});
  if(!fs.existsSync(path.join(dir,'state.json')))writeState(dir,{version:1,nextAllowedAt:Date.now()+SPACING_MS,cooldownUntil:0});
  const s=readState(dir); // Corruption is a hard error, never silently reset the rate/cooldown.
  fs.rmSync(path.join(dir,'lock'),{recursive:true,force:true});
  // A killed requester may not have persisted its last completion time.
  s.nextAllowedAt=Math.max(s.nextAllowedAt,Date.now()+SPACING_MS);writeState(dir,s);
  return s;
}
module.exports={createRegistryFetch,initializeLimiter,readState,retryDelay,CooldownError,SPACING_MS};
