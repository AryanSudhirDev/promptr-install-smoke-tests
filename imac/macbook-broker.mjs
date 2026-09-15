import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';
import {boundedExec} from './exec-bounded.mjs';
import {validTotal} from './schedule.mjs';
import {TARGETS,selectJobs} from './multi-plan.mjs';
import registryModule from './registry-fetch.cjs';
import {
 COMPLETE_INPUT_LIMIT,MACBOOK_REMOTE_LEASE_CAP,MAX_BUNDLE_BYTES,MAX_VSIX_BYTES,LeaseError,acquirePidLock,activeRemoteLeases,
 advanceTargetWithRemoteFencing,applyFreshDownload,boundedRetryAfter,completeRemoteLease,createLeaseToken,
 expireRemoteLeases,failRemoteClaim,findLeasedJob,inspectPidLock,isActiveRemoteLease,ledgerLocalActivity,
 outstandingRemoteLeases,remoteCapacity,reserveRemoteLease,
} from './macbook-lease.mjs';
const {createRegistryFetch,readState:readLimiterState,SPACING_MS}=registryModule;
const here=path.dirname(fileURLToPath(import.meta.url));
const macbookPlanRoot=path.join(here,'macbook-plan');

const jsonBytes=value=>Buffer.byteLength(JSON.stringify(value));
const atomic=(file,data)=>{const temp=`${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;fs.writeFileSync(temp,JSON.stringify(data,null,2)+'\n',{flag:'wx',mode:0o644});try{fs.renameSync(temp,file);}catch(error){try{fs.unlinkSync(temp);}catch{}throw error;}};
function writeNewJson(file,data){
 const temp=`${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
 fs.writeFileSync(temp,JSON.stringify(data,null,2)+'\n',{flag:'wx',mode:0o644});
 try{fs.linkSync(temp,file);fs.unlinkSync(temp);}catch(error){try{fs.unlinkSync(temp);}catch{}throw error;}
}
function optionalTotal(value){return value===0||validTotal(value);}
// Last line of enforcement for a MacBook plan. A typo guard, not the approved volume: keep equal to
// MAX_TARGET in api/macbook.js and macbook/policy.mjs, and deploy this file before either of them.
const MACBOOK_MAX_TARGET=50000;
async function acquireStateLock(lockPath,{isAlive,timeoutMs=5000}={}){
 const deadline=Date.now()+timeoutMs;
 while(true){
  try{return acquirePidLock(lockPath,{isAlive});}
  catch(error){if(!(error instanceof LeaseError)||error.code!=='BUSY'||Date.now()>=deadline)throw error;await sleep(25);}
 }
}

export function readTotals(root=here){
 let config;try{config=JSON.parse(fs.readFileSync(path.join(root,'config.json'),'utf8'));}catch{throw new LeaseError('CONFIG_UNAVAILABLE','Local monitor config is missing or invalid');}
 const totals={promptr:config.dailyTotal,cognispec:config.cognispecDailyTotal??0};
 if(!optionalTotal(totals.promptr)||!optionalTotal(totals.cognispec))throw new LeaseError('CONFIG_INVALID','Local monitor target totals are invalid');
 return totals;
}

export function validateMacBookPlan(plan){
 if(!plan||typeof plan!=='object'||Array.isArray(plan)||Object.keys(plan).some(k=>!['promptrDailyTotal','cognispecDailyTotal'].includes(k)))throw new LeaseError('INVALID_PLAN','MacBook plan is invalid');
 const {promptrDailyTotal,cognispecDailyTotal}=plan;
 if(!Number.isInteger(promptrDailyTotal)||promptrDailyTotal<0||promptrDailyTotal>MACBOOK_MAX_TARGET||!Number.isInteger(cognispecDailyTotal)||cognispecDailyTotal<0||cognispecDailyTotal>MACBOOK_MAX_TARGET)throw new LeaseError('INVALID_PLAN','MacBook plan exceeds its permitted range');
 return {promptrDailyTotal,cognispecDailyTotal};
}
function prepareMacBookPlan(plan,root=macbookPlanRoot){
 const totals=validateMacBookPlan(plan);fs.mkdirSync(root,{recursive:true,mode:0o700});
 atomic(path.join(root,'config.json'),{dailyTotal:totals.promptrDailyTotal,cognispecDailyTotal:totals.cognispecDailyTotal,source:'macbook-dashboard-plan'});
 return totals;
}
export function loadStores(root=here,{now=Date.now(),advance=false,idPrefix=''}={}){
 const totals=readTotals(root);
 return Object.entries(TARGETS).map(([key,target])=>{
  const file=path.join(root,target.file);let state=null;
  if(fs.existsSync(file)){try{state=JSON.parse(fs.readFileSync(file,'utf8'));}catch{throw new LeaseError('STATE_INVALID',`${target.file} is invalid`);}}
  if(advance){try{state=advanceTargetWithRemoteFencing(state,now,key,totals[key],idPrefix);}catch(error){throw error instanceof LeaseError?error:new LeaseError('STATE_INVALID',error?.message||'Could not advance the MacBook scheduler');}}
  return {...target,key,total:totals[key],file,state};
 });
}
export const persistStore=store=>{if(store.state)atomic(store.file,store.state);};
export const persistStores=stores=>{for(const store of stores)persistStore(store);};

export async function countActiveLocalContainers(exec=boundedExec){
 let result;try{result=await exec('docker',['ps','--format','{{.Names}}'],{timeout:5000,maxBuffer:1024*1024});}
 catch{throw new LeaseError('DOCKER_UNAVAILABLE','Could not verify that local QA containers are absent',{retryAfterMs:1000});}
 return result.stdout.split(/\r?\n/).filter(name=>name.startsWith('promptr-check-')).length;
}

async function responseBuffer(response,limit,label){
 const data=Buffer.from(await response.arrayBuffer());if(data.length>limit)throw new LeaseError('REGISTRY_RESPONSE_TOO_LARGE',`${label} exceeds its relay limit`);return data;
}
async function fetchOk(fetchRegistry,url){
 const response=await fetchRegistry(url);if(!response.ok)throw new LeaseError('REGISTRY_HTTP',`Registry returned HTTP ${response.status}`);return response;
}

function reportsRoot(root){
 const reports=path.join(root,'reports');
 try{const stat=fs.lstatSync(reports);if(!stat.isDirectory()||stat.isSymbolicLink())throw new LeaseError('UNSAFE_REPORT_DIR','Host reports path is not a real directory');}
 catch(error){if(error.code!=='ENOENT')throw error;fs.mkdirSync(reports,{mode:0o755});}
 return reports;
}
function claimReportDir(root,jobId){
 const reportDir=path.join(reportsRoot(root),jobId);
 try{const stat=fs.lstatSync(reportDir);if(!stat.isDirectory()||stat.isSymbolicLink())throw new LeaseError('UNSAFE_REPORT_DIR','Claim report path is not a real directory');}
 catch(error){if(error.code!=='ENOENT')throw error;fs.mkdirSync(reportDir,{mode:0o755});}
 return reportDir;
}

export async function retrieveFreshRegistry(reservation,{root=here,limiterRoot=root,registryFetchFactory=createRegistryFetch,clock=()=>Date.now()}={}){
 const {job,store}=reservation;
 const reportDir=claimReportDir(root,job.id);
 const limiterDir=path.join(limiterRoot,'registry-limit');
 readLimiterState(limiterDir); // Never create/reset the shared limiter in the broker.
 const fetchRegistry=registryFetchFactory({stateDir:limiterDir,reportDir,runId:job.id,totalTimeoutMs:30000,requestTimeoutMs:20000,maxAttempts:1});
 const targetName=store.id.split('.')[1],metadataUrl=`https://open-vsx.org/api/aryansudhir/${targetName}`;
 const metadataBytes=await responseBuffer(await fetchOk(fetchRegistry,metadataUrl),1024*1024,'Registry metadata');
 let metadata;try{metadata=JSON.parse(metadataBytes.toString('utf8'));}catch{throw new LeaseError('INVALID_METADATA','Registry metadata is not valid JSON');}
 if(typeof metadata.version!=='string'||!metadata.version||typeof metadata.files?.sha256!=='string'||typeof metadata.files?.download!=='string')throw new LeaseError('INVALID_METADATA','Registry metadata is missing version or artifact URLs');
 const expectedHash=(await responseBuffer(await fetchOk(fetchRegistry,metadata.files.sha256),1024,'Registry sha256')).toString('utf8').trim().toLowerCase();
 if(!/^[0-9a-f]{64}$/.test(expectedHash))throw new LeaseError('INVALID_HASH','Registry did not return a valid sha256');
 const downloadStart=new Date(clock()).toISOString();
 const vsix=await responseBuffer(await fetchOk(fetchRegistry,metadata.files.download),MAX_VSIX_BYTES,'VSIX');
 const downloadEnd=new Date(clock()).toISOString();
 if(vsix.length<1)throw new LeaseError('EMPTY_VSIX','Registry returned an empty VSIX');
 const actualHash=crypto.createHash('sha256').update(vsix).digest('hex');
 if(actualHash!==expectedHash)throw new LeaseError('HASH_MISMATCH','Fresh VSIX does not match the registry sha256');
 const provenance={
  schemaVersion:1,relayKind:'fresh-download-ssh-relay',cache:false,vsixRetained:false,remoteHost:'macbook',jobId:job.id,
  target:store.key,targetId:store.id,variant:job.variant,expectedVersion:metadata.version,metadataUrl,sha256Url:metadata.files.sha256,
  source:metadata.files.download,downloadStart,downloadEnd,bytes:vsix.length,sha256:actualHash,metadataSha256:crypto.createHash('sha256').update(metadataBytes).digest('hex'),
  registrySpacingMs:SPACING_MS,registryRequests:3,
 };
 writeNewJson(path.join(reportDir,'remote-download.json'),provenance);
 return {metadata,expectedVersion:metadata.version,sha256:actualHash,vsix,vsixBase64:vsix.toString('base64'),downloadStart,downloadEnd,bytes:vsix.length,provenance};
}

function bundleFor({reservation,artifact}){
 const {job,store,leaseToken,leaseUntil}=reservation;
 const bundle={jobId:job.id,target:store.key,targetId:store.id,variant:job.variant,expectedVersion:artifact.expectedVersion,metadata:artifact.metadata,sha256:artifact.sha256,vsixBase64:artifact.vsixBase64,downloadStart:artifact.downloadStart,downloadEnd:artifact.downloadEnd,leaseToken,leaseUntil};
 if(jsonBytes(bundle)>MAX_BUNDLE_BYTES)throw new LeaseError('BUNDLE_TOO_LARGE','Claim bundle exceeds 32 MiB');
 return bundle;
}

export async function peekOperation({root=here,now=Date.now(),isAlive,idPrefix='',remoteLeaseCap=1,includeLocalActivity=true}={}){
 const lockState=inspectPidLock(path.join(root,'.monitor-v2.lock'),{isAlive});
 if(lockState.state==='live')return {ok:true,operation:'peek',busy:true,available:false,retryAfterMs:250};
 if(lockState.state==='invalid')throw new LeaseError('INVALID_LOCK','The monitor lock contains an invalid PID; manual inspection is required');
 const stores=loadStores(root,{now,advance:true,idPrefix});expireRemoteLeases(stores,now); // Memory-only: peek never persists scheduler advancement or expiration.
 const remote=activeRemoteLeases(stores),localLedger=ledgerLocalActivity(stores),selected=selectJobs(stores,1)[0];
 const capacity=remoteCapacity(stores,{cap:includeLocalActivity?undefined:remoteLeaseCap,includeLocalActivity}),available=Boolean(selected&&remote.length<remoteLeaseCap&&capacity.remaining>0);
 const retryAfterMs=remote.length>=remoteLeaseCap?boundedRetryAfter(Date.parse(remote[0].job.leaseUntil)-now):selected?250:1000;
 return {ok:true,operation:'peek',busy:false,staleLock:lockState.state==='stale',available,retryAfterMs,activeRemoteLeases:remote.length,remoteCleanupPending:remote.filter(({job})=>job.status==='remote_cleanup_pending').length,activeLocalLedgerJobs:localLedger.length,remainingCapacity:capacity.remaining,pending:selectJobs(stores,Infinity).length,...(selected?{next:{jobId:selected.job.id,target:selected.store.key,targetId:selected.store.id}}:{})};
}

function matchingReservation(stores,reservation){
 const current=findLeasedJob(stores,reservation.job.id);
 if(!isActiveRemoteLease(current.job)||current.job.leaseToken!==reservation.leaseToken)throw new LeaseError('LEASE_CHANGED','The reserved MacBook lease changed before the registry download completed');
 return {...current,leaseToken:reservation.leaseToken,leaseUntil:current.job.leaseUntil};
}

export async function claimOperation({root=here,limiterRoot=root,now=Date.now(),isAlive,exec=boundedExec,registryFetchFactory=createRegistryFetch,clock=()=>Date.now(),token,idPrefix='',externalRemoteCount=0,remoteLeaseCap=1,includeLocalActivity=true}={}){
 const activeLocalContainers=await countActiveLocalContainers(exec),lockPath=path.join(root,'.monitor-v2.lock');
 let reservation,release=await acquireStateLock(lockPath,{isAlive});
 try{
  const stores=loadStores(root,{now,advance:true,idPrefix});
  reservation=reserveRemoteLease(stores,{now,activeLocalContainers,externalRemoteCount,leaseToken:token??createLeaseToken(),remoteLeaseCap,includeLocalActivity});
  persistStores(stores); // Scheduler advancement, expiry fencing, and reservation are one locked write phase.
 }finally{release();}
 if(!reservation)return {ok:true,operation:'claim',claimed:false,retryAfterMs:1000};
 let artifact;
 try{artifact=await retrieveFreshRegistry(reservation,{root,limiterRoot,registryFetchFactory,clock});}
 catch(error){
  release=await acquireStateLock(lockPath,{isAlive});
  try{
   const stores=loadStores(root),current=matchingReservation(stores,reservation);
   failRemoteClaim(current,error,Date.now());persistStore(current.store);
  }finally{release();}
  throw error;
 }
 release=await acquireStateLock(lockPath,{isAlive});
 try{
  const stores=loadStores(root),current=matchingReservation(stores,reservation);
  applyFreshDownload(current,artifact);persistStore(current.store);
  return {ok:true,operation:'claim',claimed:true,...bundleFor({reservation:current,artifact})};
 }finally{release();}
}

export function writeCompletionReports(root,jobId,files){
 // Recovery may cover a crash after reservation but before the claim report directory was created.
 const reportDir=claimReportDir(root,jobId);
 const staging=path.join(reportDir,`.macbook-complete-${process.pid}-${crypto.randomBytes(4).toString('hex')}`),missing=[];
 fs.mkdirSync(staging,{mode:0o700});
 try{
  for(const [name,data] of files){
   const destination=path.join(reportDir,name);let stat;
   try{stat=fs.lstatSync(destination);}catch(error){if(error.code!=='ENOENT')throw error;}
   if(stat){if(!stat.isFile()||stat.isSymbolicLink()||!fs.readFileSync(destination).equals(data))throw new LeaseError('REPORT_EXISTS',`${name} already exists with different or unsafe content; refusing overwrite`);continue;}
   fs.writeFileSync(path.join(staging,name),data,{flag:'wx',mode:0o644});missing.push(name);
  }
  for(const name of missing)fs.renameSync(path.join(staging,name),path.join(reportDir,name));
 }finally{try{fs.rmSync(staging,{recursive:true});}catch{}}
}

export async function recoverOperation({root=here,now=Date.now(),isAlive}={}){
 const release=acquirePidLock(path.join(root,'.monitor-v2.lock'),{isAlive});
 try{
  const stores=loadStores(root),expired=expireRemoteLeases(stores,now);
  for(const store of new Set(expired.map(item=>item.store)))persistStore(store);
  const leases=outstandingRemoteLeases(stores).map(({job})=>{
   if(typeof job.leaseToken!=='string'||!/^[A-Za-z0-9_-]{32,128}$/.test(job.leaseToken))throw new LeaseError('INVALID_REMOTE_LEASE','Outstanding MacBook lease has no valid recovery token');
   return {jobId:job.id,leaseToken:job.leaseToken,status:job.status};
  });
  return {ok:true,operation:'recover',leases};
 }finally{release();}
}

export async function completeOperation(request,{root=here,now=Date.now(),isAlive}={}){
 const release=acquirePidLock(path.join(root,'.monitor-v2.lock'),{isAlive});let stores;
 try{
  stores=loadStores(root);
  try{
   const result=completeRemoteLease(stores,request,{now,writeReports:files=>writeCompletionReports(root,request.jobId,files)});
   persistStore(result.store);
   return {ok:true,operation:'complete',jobId:result.job.id,status:result.job.status};
  }catch(error){if(error?.stateChanged)persistStores(stores);throw error;}
 }finally{release();}
}

export async function readBoundedStdin(stream=process.stdin,limit=COMPLETE_INPUT_LIMIT){
 const chunks=[];let bytes=0;
 for await(const chunk of stream){bytes+=chunk.length;if(bytes>limit)throw new LeaseError('INPUT_TOO_LARGE','Completion input exceeds 32 MiB');chunks.push(Buffer.from(chunk));}
 if(bytes===0)throw new LeaseError('INVALID_REQUEST','Completion input is empty');
 let value;try{value=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new LeaseError('INVALID_JSON','Completion input is not valid JSON');}
 return value;
}

export async function macbookPlanPeekOperation(plan,options={}){
 const root=options.planRoot??macbookPlanRoot;prepareMacBookPlan(plan,root);
 return peekOperation({...options,root,idPrefix:'macbook-',remoteLeaseCap:MACBOOK_REMOTE_LEASE_CAP,includeLocalActivity:false});
}
export async function macbookPlanClaimOperation(plan,options={}){
 const root=options.planRoot??macbookPlanRoot;prepareMacBookPlan(plan,root);
 return claimOperation({...options,root,limiterRoot:options.limiterRoot??here,idPrefix:'macbook-',externalRemoteCount:0,remoteLeaseCap:MACBOOK_REMOTE_LEASE_CAP,includeLocalActivity:false});
}
export async function macbookPlanRecoverOperation(options={}){
 const root=options.planRoot??macbookPlanRoot;if(!fs.existsSync(path.join(root,'config.json')))return {ok:true,operation:'recover',leases:[]};
 return recoverOperation({...options,root});
}
export async function macbookPlanCompleteOperation(request,options={}){return completeOperation(request,{...options,root:options.planRoot??macbookPlanRoot});}
function errorResponse(operation,error){
 const known=error instanceof LeaseError;
 const message=known?error.message:String(error?.message||'Broker operation failed').slice(0,300);
 return {ok:false,operation,code:known?error.code:'INTERNAL',error:message,...(Number.isFinite(error?.retryAfterMs)?{retryAfterMs:boundedRetryAfter(error.retryAfterMs)}:{})};
}
export async function dispatch(argv=process.argv.slice(2),options={}){
 const operation=argv[0];if(argv.length!==1||!['peek','claim','recover','complete','macbook-peek','macbook-claim','macbook-recover','macbook-complete'].includes(operation))throw new LeaseError('INVALID_OPERATION','Usage: macbook-broker.mjs peek|claim|recover|complete|macbook-peek|macbook-claim|macbook-recover|macbook-complete');
 if(operation==='peek')return peekOperation(options);
 if(operation==='claim')return claimOperation(options);
 if(operation==='recover')return recoverOperation(options);
 if(operation==='complete')return completeOperation(await readBoundedStdin(options.stdin),options);
 if(operation==='macbook-recover')return macbookPlanRecoverOperation(options);
 const request=await readBoundedStdin(options.stdin);
 if(operation==='macbook-complete')return macbookPlanCompleteOperation(request,options);
 if(!request||typeof request!=='object'||Array.isArray(request)||Object.keys(request).length!==1||!request.plan)throw new LeaseError('INVALID_PLAN','MacBook plan request must contain only plan');
 return operation==='macbook-peek'?macbookPlanPeekOperation(request.plan,options):macbookPlanClaimOperation(request.plan,options);
}

async function main(){
 const operation=process.argv[2]||'unknown';let response;
 try{response=await dispatch(process.argv.slice(2));}catch(error){response=errorResponse(operation,error);}
 const output=JSON.stringify(response);
 if(Buffer.byteLength(output)>MAX_BUNDLE_BYTES)response=errorResponse(operation,new LeaseError('OUTPUT_TOO_LARGE','Broker response exceeds 32 MiB'));
 process.stdout.write(JSON.stringify(response)+'\n');
}
if(path.resolve(process.argv[1]||'')===fileURLToPath(import.meta.url))await main();
