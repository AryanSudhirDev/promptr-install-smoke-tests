import {spawn} from 'node:child_process';
// A child can ignore SIGTERM or keep inherited pipes open. Settle the promise on our own
// deadline, SIGKILL only its dedicated process group, and detach leftover handles.
export function boundedExec(command,args=[],{timeout=30000,maxBuffer=16*1024*1024,...options}={}) {
  return new Promise((resolve,reject)=>{
    const child=spawn(command,args,{...options,detached:true,stdio:['ignore','pipe','pipe']});
    let stdout='',stderr='',bytes=0,finished=false;
    const finish=(error)=>{
      if(finished)return;finished=true;clearTimeout(timer);
      if(error){try{process.kill(-child.pid,'SIGKILL');}catch{} child.stdout.destroy();child.stderr.destroy();child.unref();reject(Object.assign(error,{stdout,stderr}));}
      else resolve({stdout,stderr});
    };
    const timer=setTimeout(()=>finish(Object.assign(new Error(`${command} exceeded ${timeout}ms hard deadline`),{code:'ETIMEDOUT'})),timeout);
    const receive=key=>data=>{bytes+=data.length;if(bytes>maxBuffer){finish(Object.assign(new Error('subprocess output limit exceeded'),{code:'EOUTPUTLIMIT'}));return;}if(key==='stdout')stdout+=data.toString();else stderr+=data.toString();};
    child.stdout.on('data',receive('stdout'));child.stderr.on('data',receive('stderr'));
    child.on('error',finish);
    child.on('close',(code,signal)=>finish(code===0?null:Object.assign(new Error(`${command} exited ${code??signal}`),{code,signal})));
  });
}
