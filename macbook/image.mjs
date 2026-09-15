import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {run} from './exec.mjs';
import {ROOT,DOCKER,workerStatus} from './runtime.mjs';
const SOURCE=fileURLToPath(new URL('../',import.meta.url));
export function buildContext(destination,source=SOURCE){
 fs.mkdirSync(destination,{recursive:true,mode:0o700});const entries=['package.json','package-lock.json','helper/package.json','helper/index.cjs','macbook/Dockerfile','macbook/entrypoint.sh','macbook/relayed-registry.cjs','macbook/promptr-arm64-suite.cjs','macbook/cognispec-arm64-suite.cjs',...fs.readdirSync(path.join(source,'imac')).filter(n=>n.endsWith('.cjs')).map(n=>'imac/'+n)];
 const h=crypto.createHash('sha256');for(const relative of entries.sort()){const bytes=fs.readFileSync(path.join(source,relative));h.update(relative).update(bytes);const out=path.join(destination,relative);fs.mkdirSync(path.dirname(out),{recursive:true});fs.writeFileSync(out,bytes);}
 const check=path.join(destination,'imac/container-check.cjs');let text=fs.readFileSync(check,'utf8');
 for(const required of ["const downloadStart = new Date().toISOString();","const downloadEnd = new Date().toISOString();","environment: 'imac-colima-container'","const root = __dirname;"])if(!text.includes(required))throw new Error('Harness relay integration requires review');
 text=text.replace('const root = __dirname;',"const root = __dirname;\n  const relay = JSON.parse(fs.readFileSync('/relay/bundle.json', 'utf8'));\n  assert.equal(relay.jobId, process.env.TEST_RUN);");
 text=text.replace('const downloadStart = new Date().toISOString();','const downloadStart = relay.downloadStart;').replace('const downloadEnd = new Date().toISOString();','const downloadEnd = relay.downloadEnd;').replaceAll("environment: 'imac-colima-container'","environment: 'macbook-docker-arm64',\n    registryTransport: 'imac-pinned-ssh-fresh-download-relay'");
 text=text.replace('// Fresh download from the registry, inside this brand-new container.','// Consume this job’s unique fresh registry retrieval through the pinned SSH relay.');fs.writeFileSync(check,text);
 return 'promptr-qa-macbook:'+h.digest('hex').slice(0,16);
}
export async function ensureImage(signal){
 workerStatus({phase:'starting_runtime',detail:'Waiting for Docker Desktop, without changing its global settings.'});
 try{await run(DOCKER,['info','--format','{{.Architecture}}'],{timeout:12000,signal});}catch{
  if(signal.aborted)throw new Error('Cancelled');await run('/usr/bin/open',['-gj','/Applications/Docker.app'],{timeout:10000,signal});
  let ready=false;for(let i=0;i<60&&!signal.aborted;i++){await new Promise(r=>setTimeout(r,3000));try{await run(DOCKER,['info','--format','{{.Architecture}}'],{timeout:5000,signal});ready=true;break;}catch{}}
  if(!ready)throw new Error('Docker is not ready. Complete Docker Desktop setup on this Mac once.');
 }
 const info=JSON.parse((await run(DOCKER,['info','--format','{{json .}}'],{timeout:10000,signal})).stdout);if(!['aarch64','arm64'].includes(info.Architecture))throw new Error('Native ARM64 Docker engine required');if(info.MemTotal<3*1024**3)throw new Error('Docker needs at least 3 GiB of VM memory');
 const context=path.join(ROOT,'build'),image=buildContext(context);let exists=false;
 try{const inspected=JSON.parse((await run(DOCKER,['image','inspect',image],{timeout:10000,signal})).stdout);exists=inspected[0]?.Architecture==='arm64';}catch{}
 if(!exists){workerStatus({phase:'building_native_image',detail:'One-time native ARM64 editor/runtime build. No extension downloads or QA counts.'});try{const r=await run(DOCKER,['build','--platform','linux/arm64','-t',image,'-f',path.join(context,'macbook/Dockerfile'),context],{timeout:25*60000,signal,maxBuffer:16*1024*1024});fs.writeFileSync(path.join(ROOT,'image-build.log'),r.stdout+r.stderr,{mode:0o600});}catch(e){fs.writeFileSync(path.join(ROOT,'image-build.log'),(e.stdout||'')+(e.stderr||''),{mode:0o600});throw new Error('Native image build did not finish; see image-build.log');}}
 const check=await run(DOCKER,['run','--rm','--network','none','--memory','512m','--cpus','1','--label','qa.macbook.runner=promptr-qa','--entrypoint','/bin/sh',image,'-c','test "$(uname -m)" = aarch64 && test -x /usr/share/code/code && node -e "require(\'@vscode/test-electron\')"'],{timeout:30000,signal});
 return image;
}
