import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {dispatch} from '../imac/macbook-broker.mjs';
function fixture(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'vm-maintenance-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));fs.writeFileSync(path.join(dir,'.vm-maintenance'),'test');return dir;}
test('VM maintenance defers new work without touching Docker, registry or ledgers',async t=>{
 const root=fixture(t);
 for(const op of ['peek','claim','macbook-peek','macbook-claim']){
  const r=await dispatch([op],{root,limiterRoot:root,exec:()=>{throw new Error('must not execute');}});
  assert.equal(r.ok,true);assert.equal(r.busy,true);assert.equal(r.available,false);assert.equal(r.claimed,false);
 }
 assert.deepEqual(fs.readdirSync(root),['.vm-maintenance']);
});
test('maintenance does not short-circuit recovery or completion',async t=>{
 const root=fixture(t);
 await assert.rejects(dispatch(['recover'],{root}),e=>e.code==='CONFIG_UNAVAILABLE');
});
test('iMac restart retains eight GiB and all four cores without raising concurrency',()=>{
 const text=fs.readFileSync(new URL('../imac/monitor.mjs',import.meta.url),'utf8');
 assert.match(text,/'--cpu','4','--memory','8','--disk','10'/);
 assert.ok(text.indexOf("'.vm-maintenance'")<text.indexOf('acquirePidLock(processLock)'));
 assert.match(text,/concurrency:GLOBAL_CHECK_CAP,maxReady:1/);
});
