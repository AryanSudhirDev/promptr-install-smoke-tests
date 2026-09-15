import fs from 'node:fs';
import {run} from './exec.mjs';
// A reboot can reuse a numeric PID. Check the expected script before deciding a
// saved PID still represents this worker; never terminate an unrelated process.
export async function acquireLocalLock(file,script,{pid=process.pid,inspect=async p=>{
 try{process.kill(p,0);}catch(e){if(e.code==='ESRCH')return false;return true;}
 try{return (await run('/bin/ps',['-p',String(p),'-o','command='],{timeout:5000,maxBuffer:16384})).stdout.includes(script);}catch{return true;}
}}={}){
 const value=String(pid),release=()=>{try{if(fs.readFileSync(file,'utf8')===value)fs.unlinkSync(file);}catch{}};
 try{fs.writeFileSync(file,value,{flag:'wx',mode:0o600});return release;}catch(e){if(e.code!=='EEXIST')throw e;}
 const old=fs.readFileSync(file,'utf8');if(!/^[1-9][0-9]*$/.test(old)||!Number.isSafeInteger(Number(old)))throw new Error('Invalid process lock; inspect before restarting');
 if(await inspect(Number(old)))return null;
 if(fs.readFileSync(file,'utf8')!==old)throw new Error('Process lock changed; retry later');fs.unlinkSync(file);
 fs.writeFileSync(file,value,{flag:'wx',mode:0o600});return release;
}
