import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const {waitForSetting}=createRequire(import.meta.url)('../imac/wait-for-setting.cjs');
function clock(){let t=0;const sleeps=[];return {now:()=>t,pause:async ms=>{sleeps.push(ms);t+=ms;},sleeps};}
test('already-applied setting has no artificial delay',async()=>{const c=clock();await waitForSetting(()=>0.6,0.6,c);assert.deepEqual(c.sleeps,[]);});
test('polls fresh effective value until delayed propagation succeeds',async()=>{const c=clock();let reads=0;await waitForSetting(()=>++reads<3?'old':'new','new',c);assert.equal(reads,3);assert.deepEqual(c.sleeps,[20,20]);});
test('an unapplied setting fails at its bounded deadline',async()=>{const c=clock();await assert.rejects(waitForSetting(()=>0,1,{...c,timeoutMs:45}),/within 45ms/);assert.deepEqual(c.sleeps,[20,20,5]);assert.equal(c.now(),45);});
test('underlying VS Code read error is not hidden or retried',async()=>{const c=clock();await assert.rejects(waitForSetting(()=>{throw new Error('config read failed');},1,c),/config read failed/);assert.deepEqual(c.sleeps,[]);});
test('reset to empty string and undefined are not truthiness shortcuts',async()=>{for(const value of ['',undefined]){const c=clock();await waitForSetting(()=>value,value,c);assert.deepEqual(c.sleeps,[]);}});
test('rejects invalid timeout or interval without looping',async()=>{for(const opts of [{timeoutMs:0},{timeoutMs:NaN},{intervalMs:-1},{intervalMs:Infinity}])await assert.rejects(waitForSetting(()=>0,1,opts),/Invalid setting wait bounds/);});
