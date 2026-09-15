import {advance,initialState,slotAt,SLOT_MS,LOOKBACK_MS,validTotal} from './schedule.mjs';
export const TARGETS={
 promptr:{id:'aryansudhir.promptr',suite:'extended-suite.cjs',marker:'PROMPTR_EXTENDED_SMOKE_TEST_PASSED',file:'scheduler-v2.json'},
 cognispec:{id:'aryansudhir.cognispec',suite:'cognispec-suite.cjs',marker:'COGNISPEC_EXTENDED_SMOKE_TEST_PASSED',file:'scheduler-cognispec-v2.json'},
};
export function advanceTarget(state,now,key,total,idPrefix=''){
 if(!TARGETS[key]||!(validTotal(total)||total===0))throw new Error('Invalid QA target or daily rate');
 if(!state){if(total===0)return null;state=initialState(key==='cognispec'?now-SLOT_MS:now,total);}
 if(total===0){
  state.lastEnqueuedAt=slotAt(now);
  for(const j of Object.values(state.jobs))if(j.status==='pending')j.status='cancelled';
  return state;
 }
 // schedule.mjs remains the same single-target allocator. Namespace its generated IDs before merging.
 const previous=state.jobs;const allocation={...state,jobs:{}};
 advance(allocation,now,total,idPrefix);
 for(const job of Object.values(allocation.jobs)){
  if(key==='cognispec')job.id='cognispec-'+job.id;
  job.target=key;previous[job.id]??=job;
 }
 state={...allocation,jobs:previous};
 for(const [id,job] of Object.entries(state.jobs)){
  if(job.status==='pending'&&job.slot<now-LOOKBACK_MS)job.status='expired';
  if(job.slot<now-7*86400000&&!['started','cleanup_pending'].includes(job.status))delete state.jobs[id];
 }
 return state;
}
export function selectJobs(stores,limit=100){
 return stores.filter(s=>s.total>0).flatMap(store=>Object.values(store.state?.jobs||{}).filter(j=>j.status==='pending').map(job=>({job,store})))
 .sort((a,b)=>a.job.slot-b.job.slot||a.job.index-b.job.index||a.store.key.localeCompare(b.store.key)).slice(0,limit);
}

export const MIN_FREE_BYTES=5*1024**3;
export function diskAllowsStart(stat){const bytes=Number(stat.bavail)*Number(stat.bsize);return Number.isFinite(bytes)&&bytes>=MIN_FREE_BYTES;}
