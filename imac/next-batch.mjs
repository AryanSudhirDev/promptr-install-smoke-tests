import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {slotAt} from './schedule.mjs';
export function needsImmediateBatch({status,states,runStartedAt,now=Date.now()}){
 if(status?.phase!=='idle'||!Number.isFinite(Date.parse(status.at))||Date.parse(status.at)<runStartedAt)return false;
 return Object.entries(states).some(([target,state])=>status.targetDailyTotals?.[target]>0&&state&&(Object.values(state.jobs||{}).some(job=>job.status==='pending')||state.lastEnqueuedAt<slotAt(now)));
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{
  const root=process.argv[2],runStartedAt=Number(process.argv[3]);
  if(!root||!Number.isFinite(runStartedAt)||fs.existsSync(path.join(root,'.vm-maintenance')))process.exit(1);
  const read=file=>{try{return JSON.parse(fs.readFileSync(path.join(root,file)));}catch(error){if(error.code==='ENOENT')return null;throw error;}};
  const again=needsImmediateBatch({status:read('status-v2.json'),states:{promptr:read('scheduler-v2.json'),cognispec:read('scheduler-cognispec-v2.json')},runStartedAt});
  process.exitCode=again?0:1;
 }catch{process.exitCode=1;}
}
