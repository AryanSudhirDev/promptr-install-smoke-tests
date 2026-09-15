import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {advanceTarget,selectJobs} from './multi-plan.mjs';

export const LEASE_MS=10*60*1000;
// This is the iMac-local cap (and remains the legacy root cap), not a fleet cap.
export const GLOBAL_CHECK_CAP=3;
export const MACBOOK_REMOTE_LEASE_CAP=11;
export const COMPLETE_INPUT_LIMIT=32*1024*1024;
export const MAX_BUNDLE_BYTES=32*1024*1024;
export const MAX_VSIX_BYTES=23*1024*1024;
export const RETRY_AFTER_MIN_MS=250;
export const RETRY_AFTER_MAX_MS=5000;
export const VARIANTS=['manifest','clean-state','settings-isolation','ui-settings','reinstall','duplicate-install'];
export const REPORT_LIMITS=new Map([
 ['installation.json',2*1024*1024],
 ['checks.json',2*1024*1024],
 ['download.json',2*1024*1024],
 ['timings.json',2*1024*1024],
 ['container.log',8*1024*1024],
 ['promptr-command-palette.png',16*1024*1024],
 ['cognispec-command-palette.png',16*1024*1024],
 ['failure.png',16*1024*1024],
]);
const LOCAL_ACTIVE_STATUSES=new Set(['started','cleanup_pending']);
const REMOTE_FENCED_STATUSES=new Set(['remote_started','remote_cleanup_pending']);

export class LeaseError extends Error {
 constructor(code,message,{retryAfterMs,stateChanged=false}={}){super(message);this.name='LeaseError';this.code=code;this.retryAfterMs=retryAfterMs;this.stateChanged=stateChanged;}
}

const jobsOf=stores=>stores.flatMap(store=>Object.values(store.state?.jobs||{}).map(job=>({store,job})));
const asTime=value=>typeof value==='number'?value:Date.parse(value);
export const boundedRetryAfter=ms=>Math.max(RETRY_AFTER_MIN_MS,Math.min(RETRY_AFTER_MAX_MS,Number.isFinite(ms)?Math.ceil(ms):1000));
export const variantForJob=job=>VARIANTS[(Math.floor(job.slot/300000)+job.index)%VARIANTS.length];
export const isActiveRemoteLease=job=>job.remoteHost==='macbook'&&REMOTE_FENCED_STATUSES.has(job.status);
export const activeRemoteLeases=stores=>jobsOf(stores).filter(({job})=>isActiveRemoteLease(job));
export const outstandingRemoteLeases=stores=>activeRemoteLeases(stores).sort((a,b)=>a.job.slot-b.job.slot||a.job.index-b.job.index||a.job.id.localeCompare(b.job.id));
export function advanceTargetWithRemoteFencing(state,now,key,total,idPrefix=''){
 const fenced=Object.values(state?.jobs||{}).filter(isActiveRemoteLease);
 const advanced=advanceTarget(state,now,key,total,idPrefix);
 if(advanced)for(const job of fenced)advanced.jobs[job.id]??=job;
 return advanced;
}
export const ledgerLocalActivity=stores=>jobsOf(stores).filter(({job})=>LOCAL_ACTIVE_STATUSES.has(job.status)&&job.remoteHost!=='macbook');

export function expireRemoteLeases(stores,now=Date.now()){
 const expired=[];
 for(const {store,job} of jobsOf(stores)){
  if(job.status!=='remote_started'||job.remoteHost!=='macbook')continue;
  const until=asTime(job.leaseUntil);
  if(Number.isFinite(until)&&until>now)continue;
  job.status='remote_cleanup_pending';job.error='MacBook lease expired; cleanup confirmation required';job.expiredAt=new Date(now).toISOString();
  job.remoteLeaseOutcome='expired_cleanup_pending';expired.push({store,job});
 }
 return expired;
}

export function remoteCapacity(stores,{now=Date.now(),activeLocalContainers=0,externalRemoteCount=0,cap=GLOBAL_CHECK_CAP,includeLocalActivity=true}={}){
 if(!Number.isInteger(activeLocalContainers)||activeLocalContainers<0||!Number.isInteger(externalRemoteCount)||externalRemoteCount<0)throw new LeaseError('INVALID_ACTIVITY','Invalid local container count');
 if(!Number.isInteger(cap)||cap<1)throw new LeaseError('INVALID_ACTIVITY','Invalid capacity limit');
 const remote=activeRemoteLeases(stores).length+externalRemoteCount;
 const ledgerLocal=ledgerLocalActivity(stores).length;
 // A running iMac check normally appears in both Docker and the ledger. Use the
 // larger observation so it occupies one fleet slot rather than being counted twice.
 const local=includeLocalActivity?Math.max(activeLocalContainers,ledgerLocal):0;
 return {remote,local,total:remote+local,remaining:Math.max(0,cap-remote-local)};
}

export function reserveLocalJob(stores,jobId,{now=Date.now(),activeLocalContainers=0,externalRemoteCount=0}={}){
 expireRemoteLeases(stores,now);
 const selected=jobsOf(stores).find(({job})=>job.id===jobId);
 if(!selected||selected.job.status!=='pending')return {started:false,reason:'not_pending'};
 const capacity=remoteCapacity(stores,{now,activeLocalContainers,externalRemoteCount});
 if(capacity.remaining<1)return {started:false,reason:'capacity',capacity};
 const {store,job}=selected,variant=variantForJob(job);
 Object.assign(job,{target:store.key,status:'started',startedAt:new Date(now).toISOString()});
 delete job.remoteHost;delete job.leaseToken;delete job.leaseUntil;delete job.finishedAt;delete job.error;
 return {started:true,store,job,variant,capacity};
}

export function createLeaseToken(randomBytes=crypto.randomBytes){
 const token=randomBytes(32).toString('base64url');
 if(!/^[A-Za-z0-9_-]{43}$/.test(token))throw new LeaseError('TOKEN_GENERATION_FAILED','Could not generate a lease token');
 return token;
}

export function reserveRemoteLease(stores,{now=Date.now(),activeLocalContainers=0,externalRemoteCount=0,leaseToken=createLeaseToken(),remoteLeaseCap=1,includeLocalActivity=true}={}){
 expireRemoteLeases(stores,now);
 if(!Number.isInteger(remoteLeaseCap)||remoteLeaseCap<1)throw new LeaseError('INVALID_ACTIVITY','Invalid remote lease limit');
 const capacity=remoteCapacity(stores,{now,activeLocalContainers,externalRemoteCount,cap:includeLocalActivity?GLOBAL_CHECK_CAP:remoteLeaseCap,includeLocalActivity});
 if(capacity.remote>=remoteLeaseCap){
  const until=Math.min(...activeRemoteLeases(stores).map(({job})=>asTime(job.leaseUntil)).filter(Number.isFinite));
  throw new LeaseError('REMOTE_ACTIVE','MacBook lease capacity is full',{retryAfterMs:boundedRetryAfter(until-now)});
 }
 if(capacity.remaining<1)throw new LeaseError('GLOBAL_CAP','The three-check capacity is full',{retryAfterMs:1000});
 if(typeof leaseToken!=='string'||!/^[A-Za-z0-9_-]{32,128}$/.test(leaseToken))throw new LeaseError('INVALID_TOKEN','Invalid lease token');
 const selected=selectJobs(stores,1)[0];
 if(!selected)return null;
 const {job,store}=selected;
 if(job.status!=='pending'||store.total<=0)throw new LeaseError('NOT_CLAIMABLE','Selected job is not pending on an enabled target');
 const leaseUntil=new Date(now+LEASE_MS).toISOString();
 Object.assign(job,{target:store.key,targetId:store.id,variant:variantForJob(job),status:'remote_started',remoteHost:'macbook',startedAt:new Date(now).toISOString(),leaseToken,leaseUntil});
 delete job.finishedAt;delete job.error;
 return {store,job,leaseToken,leaseUntil};
}

export function applyFreshDownload(reservation,artifact){
 const {job}=reservation;
 if(job.status!=='remote_started')throw new LeaseError('ILLEGAL_TRANSITION','Lease is no longer active');
 if(!artifact||typeof artifact.expectedVersion!=='string'||!artifact.expectedVersion||!/^[0-9a-f]{64}$/.test(artifact.sha256||''))throw new LeaseError('INVALID_DOWNLOAD','Fresh registry result is incomplete');
 Object.assign(job,{expectedVersion:artifact.expectedVersion,artifactSha256:artifact.sha256,downloadStart:artifact.downloadStart,downloadEnd:artifact.downloadEnd,downloadBytes:artifact.bytes,relayKind:'fresh-download-ssh-relay'});
 return job;
}

export function failRemoteClaim(reservation,error,now=Date.now()){
 const {job}=reservation;
 if(job.status!=='remote_started')throw new LeaseError('ILLEGAL_TRANSITION','Cannot fail a lease that is not active');
 job.status='failed';job.finishedAt=new Date(now).toISOString();job.remoteLeaseOutcome='claim_fetch_failed';
 job.error=safeStoredError(error);delete job.leaseToken;
 return job;
}

export async function claimWithFreshFetch(stores,{now=Date.now(),activeLocalContainers=0,leaseToken=createLeaseToken(),persist=()=>{},retrieve}={}){
 if(typeof retrieve!=='function')throw new LeaseError('INVALID_FETCHER','Fresh retrieval callback is required');
 const reservation=reserveRemoteLease(stores,{now,activeLocalContainers,leaseToken});
 // reserveRemoteLease also expires stale leases; persist every ledger before any public fetch.
 for(const store of stores)await persist(store);
 if(!reservation)return null;
 try{
  const artifact=await retrieve(reservation);
  applyFreshDownload(reservation,artifact);
  await persist(reservation.store);
  return {reservation,artifact};
 }catch(error){
  failRemoteClaim(reservation,error,Date.now());
  await persist(reservation.store);
  throw error;
 }
}

function safeStoredError(error){
 if(error instanceof LeaseError)return `${error.code}: ${error.message}`.slice(0,300);
 if(error&&Number.isInteger(error.status))return `Registry request failed with HTTP ${error.status}`;
 return 'Fresh registry retrieval failed';
}

function tokenMatches(actual,supplied){
 if(typeof actual!=='string'||typeof supplied!=='string')return false;
 const a=Buffer.from(actual),b=Buffer.from(supplied);
 return a.length===b.length&&crypto.timingSafeEqual(a,b);
}

function strictBase64(value,name){
 if(typeof value!=='string'||value.length%4!==0||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value))throw new LeaseError('INVALID_REPORT',`${name} is not canonical base64`);
 const data=Buffer.from(value,'base64');
 if(data.toString('base64')!==value)throw new LeaseError('INVALID_REPORT',`${name} is not canonical base64`);
 return data;
}

export function decodeReports(reports){
 if(!reports||typeof reports!=='object'||Array.isArray(reports))throw new LeaseError('INVALID_REPORT','reports must be a filename-to-base64 object');
 const files=new Map();let aggregate=0;
 for(const [name,value] of Object.entries(reports)){
  if(!REPORT_LIMITS.has(name)||path.basename(name)!==name||name.includes('..')||name==='registry-requests.jsonl'||name==='remote-download.json')throw new LeaseError('UNSAFE_REPORT_NAME',`Report filename is not allowed: ${String(name).slice(0,80)}`);
  const data=strictBase64(value,name),limit=REPORT_LIMITS.get(name);aggregate+=data.length;
  if(data.length>limit)throw new LeaseError('REPORT_TOO_LARGE',`${name} exceeds its size limit`);
  if(aggregate>COMPLETE_INPUT_LIMIT)throw new LeaseError('REPORT_TOO_LARGE','Decoded reports exceed the aggregate limit');
  if(name.endsWith('.png')&&(data.length<8||!data.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))))throw new LeaseError('INVALID_REPORT',`${name} is not a PNG`);
  files.set(name,data);
 }
 return files;
}

function jsonReport(files,name){
 const data=files.get(name);if(!data)throw new LeaseError('MISSING_EVIDENCE',`${name} is required for a passed result`);
 let value;try{value=JSON.parse(data.toString('utf8'));}catch{throw new LeaseError('INVALID_EVIDENCE',`${name} is not valid JSON`);}
 if(!value||typeof value!=='object'||Array.isArray(value))throw new LeaseError('INVALID_EVIDENCE',`${name} must contain a JSON object`);
 return value;
}

export function validatePassedEvidence(job,files){
 const installation=jsonReport(files,'installation.json');
 const checks=jsonReport(files,'checks.json');
 const download=jsonReport(files,'download.json');
 const log=files.get('container.log');
 if(!log)throw new LeaseError('MISSING_EVIDENCE','container.log is required for a passed result');
 if(installation.targetId!==job.targetId||installation.expectedVersion!==job.expectedVersion||installation.variant!==job.variant)throw new LeaseError('EVIDENCE_MISMATCH','Installation target, version, or variant does not match the lease');
 if(installation.freshStateBeforeInstall!==true||installation.artifactSha256!==job.artifactSha256)throw new LeaseError('EVIDENCE_MISMATCH','Installation freshness or artifact hash does not match the host download');
 if(typeof installation.container!=='string'||!/^[A-Za-z0-9_.-]{1,128}$/.test(installation.container))throw new LeaseError('INVALID_EVIDENCE','Installation container identity is missing or invalid');
 const installed=installation.installed;
 if(!Array.isArray(installed)||!installed.some(line=>String(line).toLowerCase()===`${job.targetId}@${job.expectedVersion}`.toLowerCase()))throw new LeaseError('EVIDENCE_MISMATCH','Installed extension listing does not contain the leased target and version');
 if(checks.status!=='passed'||checks.variant!==job.variant||!Array.isArray(checks.checks)||checks.checks.length<1||checks.checks.some(check=>check?.status!=='passed'))throw new LeaseError('FAILED_CHECKS','checks.json is missing passing checks for the leased variant');
 const manifest=download.manifest;
 if(download.targetId!==job.targetId||download.sha256!==job.artifactSha256||!manifest||`${manifest.publisher}.${manifest.name}`!==job.targetId||manifest.version!==job.expectedVersion)throw new LeaseError('EVIDENCE_MISMATCH','Download manifest, target, version, or hash does not match the host relay');
 const marker=job.target==='cognispec'?'COGNISPEC_EXTENDED_SMOKE_TEST_PASSED':'PROMPTR_EXTENDED_SMOKE_TEST_PASSED';
 if(!log.toString('utf8').includes(marker))throw new LeaseError('MISSING_MARKER',`Target success marker is missing from container.log`);
 return {installation,checks,download};
}

export function validateCompletionRequest(request){
 if(!request||typeof request!=='object'||Array.isArray(request))throw new LeaseError('INVALID_REQUEST','Completion payload must be an object');
 const allowed=new Set(['jobId','leaseToken','status','seconds','reports','error','cleanupConfirmed']);
 for(const key of Object.keys(request))if(!allowed.has(key))throw new LeaseError('INVALID_REQUEST',`Unexpected completion field: ${key}`);
 if(typeof request.jobId!=='string'||!/^(?:(?:macbook-)?(?:cognispec-)?|(?:cognispec-)?(?:macbook-)?)v2-[A-Za-z0-9-]{8,80}$/.test(request.jobId))throw new LeaseError('INVALID_REQUEST','Invalid jobId');
 if(typeof request.leaseToken!=='string'||request.leaseToken.length>128)throw new LeaseError('INVALID_REQUEST','Invalid leaseToken');
 if(!['passed','failed'].includes(request.status))throw new LeaseError('INVALID_REQUEST','status must be passed or failed');
 if(request.cleanupConfirmed!==true)throw new LeaseError('CLEANUP_NOT_CONFIRMED','cleanupConfirmed must be true after the MacBook container is verified absent');
 if(!request.reports||typeof request.reports!=='object'||Array.isArray(request.reports))throw new LeaseError('INVALID_REQUEST','reports must be a filename-to-base64 object');
 if(!Number.isFinite(request.seconds)||request.seconds<0||request.seconds>3600)throw new LeaseError('INVALID_REQUEST','seconds must be between 0 and 3600');
 if(request.status==='failed'&&(typeof request.error!=='string'||!request.error.trim()))throw new LeaseError('INVALID_REQUEST','A failed result requires an error');
 if(request.error!==undefined&&(typeof request.error!=='string'||request.error.length>1000))throw new LeaseError('INVALID_REQUEST','error must be at most 1000 characters');
 return request;
}

export function findLeasedJob(stores,jobId){
 for(const store of stores){const job=store.state?.jobs?.[jobId];if(job)return {store,job};}
 throw new LeaseError('UNKNOWN_JOB','Job does not exist in the shared scheduler');
}

export function completeRemoteLease(stores,request,{now=Date.now(),writeReports=()=>{}}={}){
 validateCompletionRequest(request);
 const {store,job}=findLeasedJob(stores,request.jobId);
 if(!isActiveRemoteLease(job))throw new LeaseError('ILLEGAL_TRANSITION','Job is not an outstanding MacBook lease');
 if(!tokenMatches(job.leaseToken,request.leaseToken))throw new LeaseError('WRONG_TOKEN','Lease token does not match');
 const until=asTime(job.leaseUntil),expired=!Number.isFinite(until)||until<=now;
 if(request.status==='passed'&&(job.status!=='remote_started'||expired)){
  let stateChanged=false;
  if(job.status==='remote_started'){job.status='remote_cleanup_pending';job.expiredAt=new Date(now).toISOString();job.error='MacBook lease expired; cleanup confirmation required';job.remoteLeaseOutcome='expired_cleanup_pending';stateChanged=true;}
  throw new LeaseError('LEASE_EXPIRED','An expired or quarantined lease cannot report passed',{stateChanged});
 }
 const files=decodeReports(request.reports);
 if(request.status==='passed')validatePassedEvidence(job,files);
 writeReports(files,{store,job});
 job.status=request.status;job.finishedAt=new Date(now).toISOString();job.remoteSeconds=Math.round(request.seconds*10)/10;job.remoteLeaseOutcome=request.status;job.remoteCleanupConfirmed=true;job.remoteCleanupConfirmedAt=new Date(now).toISOString();
 if(expired)job.remoteLeaseExpired=true;
 if(request.status==='failed')job.error=request.error.trim().slice(0,300);else delete job.error;
 job.leaseTokenHash=crypto.createHash('sha256').update(job.leaseToken).digest('hex');delete job.leaseToken;
 return {store,job,files};
}

export function inspectPidLock(lockPath,{isAlive=pid=>{try{process.kill(pid,0);return true;}catch(error){if(error.code==='ESRCH')return false;return true;}}}={}){
 let text;try{text=fs.readFileSync(lockPath,'utf8');}catch(error){if(error.code==='ENOENT')return {state:'unlocked'};throw error;}
 if(!/^[1-9][0-9]*$/.test(text))return {state:'invalid'};
 const pid=Number(text);if(!Number.isSafeInteger(pid))return {state:'invalid'};
 return {state:isAlive(pid)?'live':'stale',pid,text};
}

export function acquirePidLock(lockPath,{pid=process.pid,isAlive}={}){
 const value=String(pid);
 try{fs.writeFileSync(lockPath,value,{flag:'wx',mode:0o644});return ()=>releasePidLock(lockPath,value);}catch(error){if(error.code!=='EEXIST')throw error;}
 const observed=inspectPidLock(lockPath,{isAlive});
 if(observed.state==='live')throw new LeaseError('BUSY','The monitor or broker is active',{retryAfterMs:1000});
 if(observed.state==='invalid')throw new LeaseError('INVALID_LOCK','The monitor lock contains an invalid PID; manual inspection is required');
 let current;try{current=fs.readFileSync(lockPath,'utf8');}catch(error){if(error.code==='ENOENT')return acquirePidLock(lockPath,{pid,isAlive});throw error;}
 if(current!==observed.text)throw new LeaseError('BUSY','The monitor lock changed while inspected',{retryAfterMs:500});
 fs.unlinkSync(lockPath);
 try{fs.writeFileSync(lockPath,value,{flag:'wx',mode:0o644});}catch(error){if(error.code==='EEXIST')throw new LeaseError('BUSY','The monitor or broker acquired the lock',{retryAfterMs:500});throw error;}
 return ()=>releasePidLock(lockPath,value);
}

export function releasePidLock(lockPath,value=String(process.pid)){
 try{if(fs.readFileSync(lockPath,'utf8')===value)fs.unlinkSync(lockPath);}catch(error){if(error.code!=='ENOENT')throw error;}
}
