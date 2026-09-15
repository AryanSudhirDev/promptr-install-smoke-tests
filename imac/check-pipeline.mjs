import {setTimeout as sleep} from 'node:timers/promises';

// One producer overlaps fresh retrieval with bounded test consumers. Artifacts
// belong to one planned job only; maxReady is not a reusable download cache.
export async function runCheckPipeline({items,prepare,execute,discard,canPrepare=()=>true,canExecute=()=>true,concurrency=3,maxReady=1}){
 if(!Number.isInteger(concurrency)||concurrency<1||!Number.isInteger(maxReady)||maxReady<1)throw new Error('Invalid pipeline limits');
 const ready=[];let producerDone=false,fatal=null,index=0;
 const fail=error=>{fatal??=error;};
 const producer=(async()=>{
  try{
   while(index<items.length&&!fatal&&canPrepare()){
    if(ready.length>=maxReady){await sleep(25);continue;}
    const value=await prepare(items[index++]);
    if(value)ready.push(value);
   }
  }catch(error){fail(error);}finally{producerDone=true;}
 })();
 const consumer=async()=>{
  while(!producerDone||ready.length){
   const value=ready.shift();
   if(!value){await sleep(25);continue;}
   try{
    if(fatal||!canExecute())await discard(value,fatal||new Error('Testing paused safely before container start'));
    else await execute(value);
   }catch(error){fail(error);try{await discard(value,error);}catch(cleanupError){fail(cleanupError);}}
  }
 };
 await Promise.all([producer,...Array.from({length:concurrency},consumer)]);
 if(fatal)throw fatal;
}
