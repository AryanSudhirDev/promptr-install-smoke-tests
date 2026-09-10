import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {archiveReports} from '../imac/archive-reports.mjs';
test('archives old completed reports losslessly and keeps active/recent work',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'promptr-archive-'));try{
 const now=Date.now(),jobs={old:{status:'passed',finishedAt:new Date(now-2*86400000).toISOString()},recent:{status:'passed',finishedAt:new Date(now-60000).toISOString()},active:{status:'started',finishedAt:new Date(now-2*86400000).toISOString()}};
 fs.writeFileSync(path.join(root,'attempted.json'),JSON.stringify(jobs));
 for(const id of Object.keys(jobs)){fs.mkdirSync(path.join(root,'reports',id),{recursive:true});fs.writeFileSync(path.join(root,'reports',id,'test.log'),'repeated verification data\n'.repeat(500));}
 const r=archiveReports(root,now);assert.equal(r.length,1);assert.ok(r[0].archiveBytes<r[0].originalBytes);
 assert.ok(!fs.existsSync(path.join(root,'reports','old')));assert.ok(fs.existsSync(path.join(root,'reports','recent')));assert.ok(fs.existsSync(path.join(root,'reports','active')));
 const manifest=fs.readdirSync(path.join(root,'archives')).find(f=>f.endsWith('.manifest.json'));const j=JSON.parse(fs.readFileSync(path.join(root,'archives',manifest)));assert.ok(j.files['old/test.log'].sha256);assert.deepEqual(archiveReports(root,now),[]);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('unsafe report links abort archival and retain source',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'promptr-archive-'));try{
 fs.mkdirSync(path.join(root,'reports','old'),{recursive:true});fs.symlinkSync('/etc/hosts',path.join(root,'reports','old','link'));
 fs.writeFileSync(path.join(root,'attempted.json'),JSON.stringify({old:{status:'passed',finishedAt:new Date(Date.now()-2*86400000).toISOString()}}));
 assert.throws(()=>archiveReports(root),/symlink/);assert.ok(fs.existsSync(path.join(root,'reports','old')));
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
