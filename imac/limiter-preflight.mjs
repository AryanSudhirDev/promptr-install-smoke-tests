import fs from 'node:fs';
import path from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import {acquirePidLock,activeRemoteLeases,LeaseError} from './macbook-lease.mjs';
import {TARGETS} from './multi-plan.mjs';
import registryLimiter from './registry-fetch.cjs';

// Caller holds the iMac state lock and has verified its containers are absent.
// Also fence independent MacBook reservations while deciding whether recovery is
// safe. This does NOT deduct MacBook activity from the iMac container capacity.
export async function prepareSharedLimiter({limiterDir,macbookPlanRoot,localStores,timeoutMs=5000}){
 fs.mkdirSync(macbookPlanRoot,{recursive:true,mode:0o700});
 const deadline=Date.now()+timeoutMs;let release;
 while(!release){
  try{release=acquirePidLock(path.join(macbookPlanRoot,'.monitor-v2.lock'));}
  catch(error){if(!(error instanceof LeaseError)||error.code!=='BUSY'||Date.now()>=deadline)throw error;await sleep(25);}
 }
 try{
  const remoteStores=Object.values(TARGETS).map(target=>{
   const file=path.join(macbookPlanRoot,target.file);let state=null;
   try{state=JSON.parse(fs.readFileSync(file,'utf8'));}
   catch(error){if(error.code!=='ENOENT')throw new Error('Independent MacBook ledger cannot be verified',{cause:error});}
   if(state&&(!state.jobs||typeof state.jobs!=='object'||Array.isArray(state.jobs)))throw new Error('Invalid independent MacBook jobs');
   return {state};
  });
  if(activeRemoteLeases([...localStores,...remoteStores]).length){
   return {recovered:false,state:registryLimiter.readState(limiterDir)};
  }
  return {recovered:true,state:registryLimiter.initializeLimiter(limiterDir,{containersAbsent:true})};
 }finally{release();}
}
