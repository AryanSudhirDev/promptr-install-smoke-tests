import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
 DAY_WORKERS,OVERNIGHT_MAX_WORKERS,RECOMMENDED_DOCKER_GIB,SUSTAINED_HOURS,applyOvernight,dockerGiB,
 hoursUntilMorningEnd,localStatusAllowed,overnightActive,overnightClaimPlan,overnightNightChecks,parseOvernightInput,readOvernight,
 shouldSustain,startOvernightState,sustainedNeedsRenewal,workerCount,
} from '../macbook/overnight.mjs';
import {applyDockerMemorySetting,dockerMemoryMiB,withDockerMemory} from '../macbook/docker-memory.mjs';
import {DEFAULT_SETTINGS} from '../macbook/policy.mjs';

const gib=n=>n*1024**3;
const now=Date.parse('2026-09-15T07:00:00Z');

test('daytime stays at three lanes even when Docker has spare RAM',()=>{
 assert.equal(DAY_WORKERS,3);
 assert.equal(OVERNIGHT_MAX_WORKERS,11);
 assert.equal(workerCount({memTotalBytes:gib(8)}),3);
 assert.equal(workerCount({memTotalBytes:gib(24)}),3);
 assert.equal(workerCount({memTotalBytes:gib(24),overnight:false}),3);
});

test('overnight adds lanes only when Docker RAM can hold extra 2 GiB containers',()=>{
 assert.equal(workerCount({memTotalBytes:gib(8),overnight:true}),3);
 assert.equal(workerCount({memTotalBytes:8320954368,overnight:true}),3);
 assert.equal(workerCount({memTotalBytes:gib(10),overnight:true}),4);
 assert.equal(workerCount({memTotalBytes:gib(16),overnight:true}),7);
 assert.equal(workerCount({memTotalBytes:gib(24),overnight:true}),11);
 assert.equal(workerCount({memTotalBytes:gib(32),overnight:true}),11);
 assert.equal(workerCount({overnight:true}),3);
 assert.equal(RECOMMENDED_DOCKER_GIB,24);
 assert.equal(dockerGiB(gib(8)),8);
 assert.equal(dockerGiB(8320954368),7.7);
});

test('an eight-hour window keeps the 2000 + 3000 MacBook plan instead of raising it',()=>{
 const overnight=startOvernightState({now,hours:8});
 const plan=overnightClaimPlan({promptrDailyTotal:2000,cognispecDailyTotal:3000},{overnight,memTotalBytes:gib(24),now});
 assert.equal(plan.workers,11);
 assert.equal(plan.promptrNightChecks,666);
 assert.equal(plan.cognispecNightChecks,1000);
 assert.equal(plan.nightChecks,1666);
 // Eleven lanes could compute far more than the plan asks for; the plan, not the hardware, is
 // the limit, so high concurrency buys slack rather than extra volume.
 assert.ok(plan.computePerHour>plan.perHour*10);
 assert.equal(plan.promptrDailyTotal,2000);
 assert.equal(plan.cognispecDailyTotal,3000);
 const day=overnightClaimPlan({promptrDailyTotal:2000,cognispecDailyTotal:3000},{overnight:null,memTotalBytes:gib(24),now});
 assert.deepEqual({promptrDailyTotal:day.promptrDailyTotal,cognispecDailyTotal:day.cognispecDailyTotal,workers:day.workers},{promptrDailyTotal:2000,cognispecDailyTotal:3000,workers:3});
 assert.equal(overnightNightChecks({workers:3,hours:8}).nightChecks,1666);
});

test('overnight window is time-bounded and expires closed',()=>{
 const state=startOvernightState({now,hours:8});
 assert.equal(state.hours,8);
 assert.equal(overnightActive(state,now),true);
 assert.equal(overnightActive(state,now+8*3600000-1),true);
 assert.equal(overnightActive(state,now+8*3600000),false);
 assert.equal(overnightActive(null,now),false);
 assert.throws(()=>startOvernightState({now,hours:0}));
 assert.throws(()=>startOvernightState({now,hours:25}));
});

test('a full day is a valid window and keeps the same planned totals as an eight-hour night',()=>{
 assert.equal(SUSTAINED_HOURS,24);
 const overnight=startOvernightState({now,hours:SUSTAINED_HOURS});
 assert.equal(overnightActive(overnight,now+23*3600000),true);
 const plan=overnightClaimPlan({promptrDailyTotal:2000,cognispecDailyTotal:3000},{overnight,memTotalBytes:gib(24),now});
 assert.equal(plan.workers,11);
 assert.equal(plan.promptrDailyTotal,2000);
 assert.equal(plan.cognispecDailyTotal,3000);
});

test('the nightly button runs until the next 7:50 AM local',()=>{
 const at=(local,hours)=>assert.equal(hoursUntilMorningEnd(Date.parse(local)),hours);
 at('2026-09-15T23:50:00',8);
 at('2026-09-15T21:50:00',10);
 at('2026-09-16T07:49:00',1);
 at('2026-09-16T07:50:00',24);
 at('2026-09-16T08:00:00',24);
 assert.ok(hoursUntilMorningEnd()>=1&&hoursUntilMorningEnd()<=24);
});

test('sustained high concurrency needs home plus acceptable power, and renews before it lapses',()=>{
 const settings={...DEFAULT_SETTINGS,requireAC:false,requireHome:true,minBatteryPercent:40};
 const ac={known:true,percent:12,onAC:true},low={known:true,percent:39,onAC:false},ok={known:true,percent:40,onAC:false};
 assert.equal(shouldSustain({settings,power:ac,home:true}),true);
 assert.equal(shouldSustain({settings,power:ok,home:true}),true);
 assert.equal(shouldSustain({settings,power:low,home:true}),false);
 assert.equal(shouldSustain({settings,power:ac,home:false}),false);
 assert.equal(shouldSustain({settings:{...settings,enabled:false},power:ac,home:true}),false);
 assert.equal(shouldSustain({settings:{...settings,requireAC:true},power:ok,home:true}),false);
 assert.equal(shouldSustain(),false);
 const day=startOvernightState({now,hours:24});
 assert.equal(sustainedNeedsRenewal(null,now),true);
 assert.equal(sustainedNeedsRenewal(day,now),false);
 assert.equal(sustainedNeedsRenewal(day,now+18*3600000),false);
 assert.equal(sustainedNeedsRenewal(day,now+18*3600000+1),true);
 assert.equal(sustainedNeedsRenewal(day,now+24*3600000),true);
});

test('overnight file starts, reads, expires, and stops without leftover state',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'macbook-overnight-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 assert.equal(readOvernight(root,now),null);
 const started=applyOvernight(root,{hours:8},{now});
 assert.equal(readOvernight(root,now).until,started.overnight.until);
 assert.equal(readOvernight(root,now+8*3600000),null);
 assert.equal(applyOvernight(root,{stop:true},{now}).overnight,null);
 assert.equal(fs.existsSync(path.join(root,'overnight.json')),false);
});

test('local status page owns the overnight POST and never opens writes to foreign origins',()=>{
 const source=fs.readFileSync(new URL('../macbook/supervisor.mjs',import.meta.url),'utf8');
 assert.match(source,/POST.*\/overnight/);
 assert.match(source,/localStatusAllowed/);
 assert.match(source,/restartWorker/);
 assert.match(source,/scheduleWorkerRestart/);
 assert.match(source,/applyOvernightDockerMemory/);
 assert.match(source,/maintainSustainedWindow/);
 assert.match(source,/shouldSustain/);
 assert.match(source,/hoursUntilMorningEnd\(\)/);
 // Losing home or power must take the window away, not wait for it to expire.
 assert.match(source,/applyOvernight\(ROOT,\{stop:true\}\)/);
});

test('Docker settings write only MemoryMiB and SwapMiB and are a no-op when already at 24 GiB',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'docker-memory-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const file=path.join(dir,'settings-store.json');
 fs.writeFileSync(file,JSON.stringify({AutoStart:false,SettingsVersion:45},null,2)+'\n');
 const first=applyDockerMemorySetting(file);
 assert.equal(first.changed,true);assert.equal(first.memoryMiB,24*1024);assert.equal(first.swapMiB,8*1024);
 const saved=JSON.parse(fs.readFileSync(file,'utf8'));
 assert.equal(saved.AutoStart,false);assert.equal(dockerMemoryMiB(saved),24*1024);assert.equal(saved.SwapMiB,8*1024);
 assert.equal(applyDockerMemorySetting(file).changed,false);
 assert.deepEqual(withDockerMemory({MemoryMiB:8192},{memoryMiB:24*1024}).MemoryMiB,24*1024);
});

test('overnight form and JSON bodies parse, and local status stays loopback-only',()=>{
 assert.deepEqual(parseOvernightInput('hours=8','application/x-www-form-urlencoded'),{hours:8});
 assert.deepEqual(parseOvernightInput('stop=1','application/x-www-form-urlencoded'),{stop:true});
 assert.deepEqual(parseOvernightInput('{"hours":6}','application/json'),{hours:6});
 assert.deepEqual(parseOvernightInput('{"stop":true}','application/json'),{stop:true});
 assert.deepEqual(parseOvernightInput('',''),{hours:8});
 assert.throws(()=>parseOvernightInput('hours=1.5','application/x-www-form-urlencoded'));
 assert.equal(localStatusAllowed({host:'127.0.0.1:47831'}),true);
 assert.equal(localStatusAllowed({host:'127.0.0.1:47831',origin:'http://127.0.0.1:47831'}),true);
 assert.equal(localStatusAllowed({host:'127.0.0.1:47831',origin:'https://evil.example'}),false);
 assert.equal(localStatusAllowed({host:'192.168.1.2:47831'}),false);
});
