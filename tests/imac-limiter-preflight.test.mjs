import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {prepareSharedLimiter} from '../imac/limiter-preflight.mjs';
import {acquirePidLock} from '../imac/macbook-lease.mjs';
function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'limiter-preflight-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const limiterDir=path.join(root,'registry-limit'),macbookPlanRoot=path.join(root,'macbook-plan');
 fs.mkdirSync(path.join(limiterDir,'lock'),{recursive:true});fs.mkdirSync(macbookPlanRoot);
 fs.writeFileSync(path.join(limiterDir,'state.json'),JSON.stringify({version:1,nextAllowedAt:1,cooldownUntil:Date.now()+300000}));
 fs.writeFileSync(path.join(limiterDir,'lock','owner.json'),JSON.stringify({runId:'macbook-test',token:'must-survive'}));
 return {limiterDir,macbookPlanRoot,localStores:[]};
}
for(const status of ['remote_started','remote_cleanup_pending'])test(`independent ${status} prevents iMac from resetting the registry lock`,async t=>{
 const opts=fixture(t);
 fs.writeFileSync(path.join(opts.macbookPlanRoot,'scheduler-v2.json'),JSON.stringify({jobs:{job:{id:'job',remoteHost:'macbook',status}}}));
 const result=await prepareSharedLimiter(opts);assert.equal(result.recovered,false);
 assert.equal(JSON.parse(fs.readFileSync(path.join(opts.limiterDir,'lock','owner.json'))).token,'must-survive');
});
test('preflight takes the independent reservation lock before checking leases',async t=>{
 const opts=fixture(t),release=acquirePidLock(path.join(opts.macbookPlanRoot,'.monitor-v2.lock'));
 try{await assert.rejects(prepareSharedLimiter({...opts,timeoutMs:30}),e=>e.code==='BUSY');assert.ok(fs.existsSync(path.join(opts.limiterDir,'lock')));}finally{release();}
});
test('quiet fleet can recover an abandoned lock without clearing cooldown',async t=>{
 const opts=fixture(t),before=JSON.parse(fs.readFileSync(path.join(opts.limiterDir,'state.json')));
 const result=await prepareSharedLimiter(opts);assert.equal(result.recovered,true);assert.equal(result.state.cooldownUntil,before.cooldownUntil);assert.ok(!fs.existsSync(path.join(opts.limiterDir,'lock')));
});
test('corrupt independent ledger fails closed rather than clearing its lock',async t=>{
 const opts=fixture(t);fs.writeFileSync(path.join(opts.macbookPlanRoot,'scheduler-v2.json'),'{bad');
 await assert.rejects(prepareSharedLimiter(opts),/cannot be verified/);assert.ok(fs.existsSync(path.join(opts.limiterDir,'lock')));
});
