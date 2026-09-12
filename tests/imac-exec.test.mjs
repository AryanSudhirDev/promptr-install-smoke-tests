import test from 'node:test';
import assert from 'node:assert/strict';
import {boundedExec} from '../imac/exec-bounded.mjs';
test('captures a successful child and rejects failures',async()=>{
 assert.equal((await boundedExec(process.execPath,['-e','console.log("ok")'])).stdout.trim(),'ok');
 await assert.rejects(boundedExec(process.execPath,['-e','process.exit(3)']),e=>e.code===3);
});
test('hard timeout settles even when SIGTERM is ignored',async()=>{
 const start=Date.now();await assert.rejects(boundedExec(process.execPath,['-e','process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'],{timeout:200}),e=>e.code==='ETIMEDOUT');
 assert.ok(Date.now()-start<2000);
});
test('grandchildren retaining output pipes cannot wedge the deadline',async()=>{
 const source='require("child_process").spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:["ignore",process.stdout,process.stderr]}).unref()';
 const start=Date.now();await assert.rejects(boundedExec(process.execPath,['-e',source],{timeout:200}),e=>e.code==='ETIMEDOUT');assert.ok(Date.now()-start<2000);
});
test('output overflow and missing executable are bounded failures',async()=>{
 await assert.rejects(boundedExec(process.execPath,['-e','console.log("x".repeat(10000))'],{maxBuffer:100}),e=>e.code==='EOUTPUTLIMIT');
 await assert.rejects(boundedExec('/nonexistent/promptr-command'),e=>e.code==='ENOENT');
});
