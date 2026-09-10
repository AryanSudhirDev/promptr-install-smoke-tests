// Lossless archival of completed reports, never active or recent work.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const here=path.dirname(fileURLToPath(import.meta.url));
function inventory(dir, relative='') {
  const result={};
  for(const e of fs.readdirSync(path.join(dir,relative),{withFileTypes:true})) {
    const name=relative?relative+'/'+e.name:e.name, p=path.join(dir,name), st=fs.lstatSync(p);
    if(st.isSymbolicLink()) throw new Error('unexpected symlink: '+name);
    if(st.isDirectory()) Object.assign(result,inventory(dir,name));
    else if(st.isFile()) {
      // Old copied VS Code logs sometimes have write-only permissions despite being owned by us.
      if(!(st.mode&0o400)) fs.chmodSync(p,st.mode|0o400);
      result[name]={bytes:st.size,sha256:crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')};
    } else throw new Error('unsupported report entry: '+name);
  }
  return result;
}
const writeJSON=(p,j)=>fs.writeFileSync(p,JSON.stringify(j,null,2)+'\n',{flag:'wx'});
export function archiveReports(root=here, now=Date.now()) {
  const reports=path.join(root,'reports'), archives=path.join(root,'archives');
  fs.mkdirSync(archives,{recursive:true});
  const lock=path.join(archives,'.archive.lock');
  try{fs.writeFileSync(lock,String(process.pid),{flag:'wx'});}catch(e){if(e.code==='EEXIST')throw new Error('archive lock exists; inspect before retrying');throw e;}
  const results=[];
  try {
    let ledger={};for(const file of ['attempted.json','scheduler-v2.json']){
      if(fs.existsSync(path.join(root,file))){const j=JSON.parse(fs.readFileSync(path.join(root,file)));Object.assign(ledger,j.jobs||j);}
    }
    const groups=new Map();
    for(const id of fs.readdirSync(reports)) {
      if(!/^[a-zA-Z0-9-]+$/.test(id))continue;
      const job=ledger[id];if(!job||!['passed','failed','interrupted'].includes(job.status))continue;
      const t=Date.parse(job.finishedAt);if(!Number.isFinite(t)||t>now-86400000)continue;
      const day=new Date(t).toLocaleDateString('en-CA',{timeZone:'America/Los_Angeles'});
      if(!groups.has(day))groups.set(day,[]);groups.get(day).push(id);
    }
    for(const [day,ids] of groups) {
      ids.sort();const name=`reports-${day}-${now}-${crypto.randomBytes(3).toString('hex')}`;
      const temp=path.join(archives,name+'.tar.gz.partial'),final=path.join(archives,name+'.tar.gz');
      const verify=fs.mkdtempSync(path.join(archives,'.verify-'));
      let original={};
      try {
        for(const id of ids)for(const [p,v] of Object.entries(inventory(path.join(reports,id))))original[id+'/'+p]=v;
        execFileSync('/usr/bin/tar',['-czf',temp,'-C',reports,'--',...ids],{timeout:180000,stdio:'pipe'});
        execFileSync('/usr/bin/tar',['-xzf',temp,'-C',verify],{timeout:180000,stdio:'pipe'});
        const unpacked=inventory(verify);
        const equal=(a,b)=>Object.keys(a).length===Object.keys(b).length&&Object.entries(a).every(([p,v])=>b[p]?.bytes===v.bytes&&b[p]?.sha256===v.sha256);
        if(!equal(original,unpacked))throw new Error('extracted archive differs from source');
        let unchanged={};for(const id of ids)for(const [p,v] of Object.entries(inventory(path.join(reports,id))))unchanged[id+'/'+p]=v;
        if(!equal(original,unchanged))throw new Error('source changed during archival');
        fs.renameSync(temp,final);
        const summary={archive:path.basename(final),createdAt:new Date().toISOString(),day,reportIds:ids,
          originalBytes:Object.values(original).reduce((s,v)=>s+v.bytes,0),archiveBytes:fs.statSync(final).size,
          archiveSha256:crypto.createHash('sha256').update(fs.readFileSync(final)).digest('hex'),files:original};
        writeJSON(path.join(archives,name+'.manifest.json'),summary);
        // Delete only after decompression, per-file hashes, source recheck, and manifest all succeed.
        for(const id of ids)fs.rmSync(path.join(reports,id),{recursive:true});
        results.push({archive:summary.archive,reports:ids.length,originalBytes:summary.originalBytes,archiveBytes:summary.archiveBytes});
      } finally {fs.rmSync(verify,{recursive:true,force:true});if(fs.existsSync(temp))fs.unlinkSync(temp);}
    }
    return results;
  } finally {fs.unlinkSync(lock);}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))console.log(JSON.stringify(archiveReports(),null,2));
