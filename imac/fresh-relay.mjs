import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import registry from './registry-fetch.cjs';
const MAX_VSIX=23*1024*1024;
const identity=id=>{if(!/^[A-Za-z0-9_-]{1,160}$/.test(id))throw new Error('Invalid job identity');return id;};
export const relayDirectory=(root,id)=>path.join(root,'staging',identity(id),'relay');
export function removeJobRelay(root,id){fs.rmSync(path.dirname(relayDirectory(root,id)),{recursive:true,force:true});}
export async function prepareFreshRelay({root,job,store,variant,fetchFactory=registry.createRegistryFetch,now=()=>Date.now()}){
 identity(job.id);
 if(!['aryansudhir.promptr','aryansudhir.cognispec'].includes(store.id))throw new Error('Invalid extension identity');
 const reportDir=path.join(root,'reports',job.id);fs.mkdirSync(reportDir,{recursive:true});
 const relayDir=relayDirectory(root,job.id);fs.mkdirSync(relayDir,{recursive:true,mode:0o700});
 const bundlePath=path.join(relayDir,'bundle.json');
 if(fs.existsSync(bundlePath))throw new Error('Prior job artifact exists; refusing reuse');
 const fetchRegistry=fetchFactory({stateDir:path.join(root,'registry-limit'),reportDir,runId:job.id,clientClass:'imac',totalTimeoutMs:100000,overallDeadline:Date.now()+100000,requestTimeoutMs:20000,maxAttempts:1});
 const get=async(url,limit)=>{const r=await fetchRegistry(url);if(!r.ok)throw new Error('Registry HTTP '+r.status);const bytes=Buffer.from(await r.arrayBuffer());if(bytes.length>limit)throw new Error('Registry response exceeded limit');return bytes;};
 const target=store.id.split('.')[1],metadataUrl='https://open-vsx.org/api/aryansudhir/'+target;
 const metadataBytes=await get(metadataUrl,1024*1024),metadata=JSON.parse(metadataBytes.toString('utf8'));
 if(typeof metadata.version!=='string'||!metadata.version||typeof metadata.files?.sha256!=='string'||typeof metadata.files?.download!=='string')throw new Error('Incomplete registry metadata');
 const expectedHash=(await get(metadata.files.sha256,1024)).toString('utf8').trim().toLowerCase();
 if(!/^[0-9a-f]{64}$/.test(expectedHash))throw new Error('Invalid published SHA-256');
 const downloadStart=new Date(now()).toISOString(),bytes=await get(metadata.files.download,MAX_VSIX),downloadEnd=new Date(now()).toISOString();
 if(!bytes.length)throw new Error('Empty VSIX');
 const sha256=crypto.createHash('sha256').update(bytes).digest('hex');if(sha256!==expectedHash)throw new Error('Fresh VSIX does not match the published SHA-256');
 const provenance={schemaVersion:1,relayKind:'fresh-download-host-relay',downloadEnvironment:'imac-host',cache:false,retention:'single-job-only',jobId:job.id,targetId:store.id,variant,expectedVersion:metadata.version,metadataUrl,source:metadata.files.download,downloadStart,downloadEnd,bytes:bytes.length,sha256,registrySpacingMs:registry.SPACING_MS};
 // Receipt first: a later test failure never erases a genuine verified download.
 fs.writeFileSync(path.join(reportDir,'host-download.json'),JSON.stringify(provenance,null,2)+'\n',{flag:'wx',mode:0o644});
 const bundle={jobId:job.id,target,targetId:store.id,variant,expectedVersion:metadata.version,metadata,sha256,downloadStart,downloadEnd,vsixBase64:bytes.toString('base64'),provenance};
 fs.writeFileSync(bundlePath,JSON.stringify(bundle),{flag:'wx',mode:0o600});
 return {relayDir,provenance};
}
