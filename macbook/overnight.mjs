import fs from 'node:fs';
import path from 'node:path';

export const DAY_WORKERS=3;
export const OVERNIGHT_MAX_WORKERS=11;
export const CONTAINER_MEMORY_GIB=2;
export const DOCKER_RESERVE_GIB=1;
export const OVERNIGHT_HOURS_DEFAULT=8;
export const OVERNIGHT_HOURS_MIN=1;
export const OVERNIGHT_HOURS_MAX=12;
export const OVERNIGHT_FILE='overnight.json';
export const RECOMMENDED_DOCKER_GIB=24;
export const CHECK_SECONDS=18.5;
export const OVERNIGHT_PROMPTR_CHECKS=6000;
export const OVERNIGHT_COGNISPEC_CHECKS=3500;
export const OVERNIGHT_TARGET_CHECKS=OVERNIGHT_PROMPTR_CHECKS+OVERNIGHT_COGNISPEC_CHECKS;
export const MAX_PLAN_TARGET=50000;
const GIB=1024**3;

export function overnightActive(state,now=Date.now()){
 if(!state||typeof state!=='object'||Array.isArray(state))return false;
 const until=Date.parse(state.until);
 return Number.isFinite(until)&&until>now;
}

export function workerCount({memTotalBytes=0,overnight=false}={}){
 if(!overnight)return DAY_WORKERS;
 if(!Number.isFinite(memTotalBytes)||memTotalBytes<=0)return DAY_WORKERS;
 const byRam=Math.floor((memTotalBytes-DOCKER_RESERVE_GIB*GIB)/(CONTAINER_MEMORY_GIB*GIB));
 return Math.min(OVERNIGHT_MAX_WORKERS,Math.max(DAY_WORKERS,byRam));
}

export function overnightNightChecks({workers,hours=OVERNIGHT_HOURS_DEFAULT}={}){
 if(!Number.isInteger(workers)||workers<1||!Number.isInteger(hours)||hours<OVERNIGHT_HOURS_MIN||hours>OVERNIGHT_HOURS_MAX)throw new Error('Invalid overnight capacity');
 const computePerHour=workers*(3600/CHECK_SECONDS);
 const factor=hours/OVERNIGHT_HOURS_DEFAULT;
 const wantedPromptr=Math.round(OVERNIGHT_PROMPTR_CHECKS*factor);
 const wantedCognispec=Math.round(OVERNIGHT_COGNISPEC_CHECKS*factor);
 const wanted=wantedPromptr+wantedCognispec;
 const computeTotal=Math.floor(computePerHour*hours);
 const nightChecks=Math.min(wanted,computeTotal);
 const promptrNightChecks=nightChecks===wanted?wantedPromptr:Math.round(wantedPromptr*nightChecks/wanted);
 const cognispecNightChecks=nightChecks-promptrNightChecks;
 return {workers,hours,computePerHour:Math.floor(computePerHour),perHour:Math.floor(nightChecks/hours),nightChecks,promptrNightChecks,cognispecNightChecks};
}

export function overnightClaimPlan(settings,{overnight,memTotalBytes=0,now=Date.now()}={}){
 const day={promptrDailyTotal:settings.promptrDailyTotal,cognispecDailyTotal:settings.cognispecDailyTotal};
 if(!overnightActive(overnight,now))return {...day,workers:DAY_WORKERS};
 const workers=workerCount({memTotalBytes,overnight:true});
 const hours=Number.isInteger(overnight.hours)?overnight.hours:OVERNIGHT_HOURS_DEFAULT;
 const stats=overnightNightChecks({workers,hours});
 const promptrDailyTotal=Math.min(MAX_PLAN_TARGET,Math.max(day.promptrDailyTotal,Math.ceil(stats.promptrNightChecks*24/hours)));
 const cognispecDailyTotal=Math.min(MAX_PLAN_TARGET,Math.max(day.cognispecDailyTotal,Math.ceil(stats.cognispecNightChecks*24/hours)));
 return {promptrDailyTotal,cognispecDailyTotal,...stats};
}

export function dockerGiB(memTotalBytes){
 if(!Number.isFinite(memTotalBytes)||memTotalBytes<=0)return null;
 return Math.round((memTotalBytes/GIB)*10)/10;
}

export function startOvernightState({now=Date.now(),hours=OVERNIGHT_HOURS_DEFAULT}={}){
 if(!Number.isInteger(hours)||hours<OVERNIGHT_HOURS_MIN||hours>OVERNIGHT_HOURS_MAX)throw new Error('Invalid overnight duration');
 return {until:new Date(now+hours*3600000).toISOString(),hours,startedAt:new Date(now).toISOString()};
}

export function readOvernight(root,now=Date.now()){
 try{
  const state=JSON.parse(fs.readFileSync(path.join(root,OVERNIGHT_FILE),'utf8'));
  return overnightActive(state,now)?state:null;
 }catch{return null;}
}

export function applyOvernight(root,action,{now=Date.now()}={}){
 const file=path.join(root,OVERNIGHT_FILE);
 if(action?.stop){
  try{fs.unlinkSync(file);}catch(error){if(error.code!=='ENOENT')throw error;}
  return {overnight:null};
 }
 const overnight=startOvernightState({now,hours:action?.hours??OVERNIGHT_HOURS_DEFAULT});
 fs.mkdirSync(root,{recursive:true,mode:0o700});
 const tmp=file+'.tmp';
 fs.writeFileSync(tmp,JSON.stringify(overnight,null,2)+'\n',{mode:0o600});
 fs.renameSync(tmp,file);
 return {overnight};
}

export function parseOvernightInput(text,contentType=''){
 const raw=typeof text==='string'?text:'';
 const type=String(contentType||'').split(';')[0].trim().toLowerCase();
 let stop=false,hours=OVERNIGHT_HOURS_DEFAULT;
 if(type==='application/json'){
  let body;try{body=JSON.parse(raw||'{}');}catch{throw new Error('Invalid overnight request');}
  if(!body||typeof body!=='object'||Array.isArray(body))throw new Error('Invalid overnight request');
  if(body.stop===true)stop=true;
  else if(body.hours!==undefined)hours=body.hours;
 }else{
  const params=new URLSearchParams(raw);
  if(params.get('stop')==='1'||params.get('stop')==='true')stop=true;
  else if(params.has('hours'))hours=Number(params.get('hours'));
 }
 if(stop)return {stop:true};
 if(!Number.isInteger(hours))throw new Error('Invalid overnight duration');
 return {hours};
}

export function localStatusAllowed({host,origin,port=47831}={}){
 const allowed=new Set(['127.0.0.1:'+port,'localhost:'+port]);
 if(!allowed.has(host||''))return false;
 if(!origin)return true;
 try{
  const url=new URL(origin);
  return url.protocol==='http:'&&allowed.has(url.host);
 }catch{return false;}
}
