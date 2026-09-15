import fs from 'node:fs';
import path from 'node:path';
import {run} from './exec.mjs';
import {parsePower,onPhysicalHomeNetwork,gate,validateSettings} from './policy.mjs';
export const ROOT=process.env.MACBOOK_QA_HOME||path.join(process.env.HOME,'Library/Application Support/Promptr QA MacBook');
export const DOCKER='/Applications/Docker.app/Contents/Resources/bin/docker';
// launchd's minimal PATH omits Docker's credential helpers. Keep the existing
// credential store intact and let Docker invoke its installed helper normally.
if(process.platform==='darwin')process.env.PATH=path.dirname(DOCKER)+path.delimiter+(process.env.PATH||'/usr/bin:/bin:/usr/sbin:/sbin');
export function atomic(file,data){fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});const tmp=file+'.tmp';fs.writeFileSync(tmp,JSON.stringify(data,null,2)+'\n',{mode:0o600});fs.renameSync(tmp,file);}
export function localConfig(){return JSON.parse(fs.readFileSync(path.join(ROOT,'local.json'),'utf8'));}
export async function power(){try{return parsePower((await run('/usr/bin/pmset',['-g','batt'],{timeout:5000})).stdout);}catch{return {known:false,percent:null,onAC:false};}}
export const shellQuote=s=>"'"+s.replaceAll("'","'\\''")+"'";
export function sshArgs(homeRequired=true){const c=localConfig();return ['-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','ConnectionAttempts=1','-o','ConnectTimeout=5','-o','ServerAliveInterval=15','-o','ServerAliveCountMax=2','-o','ProxyJump=none','-o','ProxyCommand=none','-o','ControlMaster=no','-o','HostKeyAlias='+c.homeHostKeyAlias,'-o','Hostname='+(homeRequired?c.homeHost:c.remoteHost),c.sshAlias];}
export async function atHome(){const c=localConfig();try{if(!onPhysicalHomeNetwork(c.homeSubnet))return false;const r=await run('/usr/bin/ssh',[...sshArgs(true),'printf HOME_QA_OK'],{timeout:8000,maxBuffer:2048});return r.stdout==='HOME_QA_OK';}catch{return false;}}
export function freeBytes(){const s=fs.statfsSync(ROOT);return Number(s.bavail)*Number(s.bsize);}
export async function eligibility(settings,{configFresh=true,probeHome=true,knownHome=false}={}){validateSettings(settings);const p=await power();const home=settings.requireHome?(probeHome?await atHome():knownHome):false;return {...gate({settings,power:p,home,freeBytes:freeBytes(),configFresh}),power:p,home};}
export function workerStatus(update){atomic(path.join(ROOT,'worker-status.json'),{at:new Date().toISOString(),...update});}
export async function broker(action,input,settings,{signal,timeout=120000}={}){if(!['peek','claim','complete','recover'].includes(action))throw new Error('Invalid broker action');const c=localConfig(),cmd='export PATH="$HOME/.local/bin:$HOME/.local/lima/bin:/usr/bin:/bin:/usr/sbin:/sbin"; exec '+[c.remoteNode,c.brokerPath,action].map(shellQuote).join(' ');const r=await run('/usr/bin/ssh',[...sshArgs(settings.requireHome),cmd],{timeout,signal,input:input?JSON.stringify(input):'',maxBuffer:32*1024*1024});let parsed;try{parsed=JSON.parse(r.stdout);}catch{throw new Error('Invalid broker response');}if(parsed.ok===false)throw Object.assign(new Error(parsed.error||'Broker rejected request'),{code:parsed.code,retryAfterMs:parsed.retryAfterMs});return parsed;}
