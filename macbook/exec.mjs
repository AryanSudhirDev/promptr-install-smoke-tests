import {spawn} from 'node:child_process';
export function run(command,args=[],{timeout=30000,input='',signal,maxBuffer=32*1024*1024,cwd,env=process.env}={}){
 return new Promise((resolve,reject)=>{
  let stdout='',stderr='',bytes=0,done=false;
  if(signal?.aborted)return reject(new Error('Operation cancelled'));
  const child=spawn(command,args,{cwd,env,detached:true,stdio:['pipe','pipe','pipe']});
  const finish=err=>{if(done)return;done=true;clearTimeout(timer);signal?.removeEventListener('abort',cancel);if(err){try{process.kill(-child.pid,'SIGKILL');}catch{}child.stdout.destroy();child.stderr.destroy();child.stdin.destroy();child.unref();reject(Object.assign(err,{stdout,stderr}));}else resolve({stdout,stderr});};
  const cancel=()=>finish(new Error('Operation cancelled'));
  const timer=setTimeout(()=>finish(new Error('Command deadline exceeded')),timeout);
  const collect=k=>d=>{bytes+=d.length;if(bytes>maxBuffer)return finish(new Error('Command output exceeded limit'));if(k==='stdout')stdout+=d;else stderr+=d;};
  child.stdout.on('data',collect('stdout'));child.stderr.on('data',collect('stderr'));child.stdin.on('error',()=>{});child.on('error',finish);child.on('close',(code,signal)=>finish(code===0?null:new Error(`Command exited ${code??signal}`)));signal?.addEventListener('abort',cancel,{once:true});child.stdin.end(input);
 });
}
