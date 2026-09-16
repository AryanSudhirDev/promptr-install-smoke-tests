import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {DEFAULT_SETTINGS,parsePower,gate,powerAllowsWork,validateSettings,onPhysicalHomeNetwork} from '../macbook/policy.mjs';
import {buildContext} from '../macbook/image.mjs';
const text=n=>`Now drawing from 'AC Power'\n -InternalBattery-0 (id=36503651)\t${n}%; charging; 1:39 remaining present: true`;
const healthy={settings:DEFAULT_SETTINGS,power:parsePower(text(51)),home:true,freeBytes:50*1024**3};
const onBattery=n=>parsePower(text(n).replace('AC Power','Battery Power'));
test('plugged in always qualifies; on battery only at or above the 40% floor',()=>{
 assert.equal(DEFAULT_SETTINGS.minBatteryPercent,40);
 assert.equal(DEFAULT_SETTINGS.requireAC,false);
 for(const n of [0,5,39,40,100])assert.equal(gate({...healthy,power:parsePower(text(n))}).eligible,true,'on AC at '+n+'%');
 for(const n of [40,41,80,100])assert.equal(gate({...healthy,power:onBattery(n)}).eligible,true,'on battery at '+n+'%');
 for(const n of [0,20,39])assert.deepEqual(gate({...healthy,power:onBattery(n)}).reasons,['battery_threshold'],'on battery at '+n+'%');
});
test('requireAC still forces mains power when a dashboard turns it on',()=>{
 const strict={...healthy,settings:{...DEFAULT_SETTINGS,requireAC:true}};
 assert.equal(gate({...strict,power:parsePower(text(5))}).eligible,true);
 assert.deepEqual(gate({...strict,power:onBattery(90)}).reasons,['unplugged']);
 assert.equal(powerAllowsWork({settings:DEFAULT_SETTINGS,power:onBattery(90)}),true);
 assert.equal(powerAllowsWork({settings:DEFAULT_SETTINGS,power:onBattery(39)}),false);
 assert.equal(powerAllowsWork({settings:DEFAULT_SETTINGS,power:parsePower(text(1))}),true);
 assert.equal(powerAllowsWork({settings:DEFAULT_SETTINGS,power:parsePower('')}),false);
 assert.equal(powerAllowsWork({settings:DEFAULT_SETTINGS,power:{}}),false);
});
test('unknown or malformed power fails closed',()=>{for(const t of ['',"Now drawing from 'AC Power'",text(101),'80%'])assert.equal(parsePower(t).known,false);assert(gate({...healthy,power:parsePower('')}).reasons.includes('power_unknown'));});
test('disabled, unavailable settings and low disk each prevent work',()=>{for(const change of [{settings:{...DEFAULT_SETTINGS,enabled:false}},{configFresh:false},{freeBytes:19*1024**3},{freeBytes:NaN}])assert.equal(gate({...healthy,...change}).eligible,false);});
test('being away no longer stops work by default, but still can when required',()=>{
 assert.equal(DEFAULT_SETTINGS.requireHome,false);
 assert.equal(gate({...healthy,home:false}).eligible,true);
 assert.equal(gate({...healthy,home:false,power:onBattery(80)}).eligible,true);
 assert.equal(gate({...healthy,home:false,power:onBattery(20)}).eligible,false);
 const strict={...healthy,settings:{...DEFAULT_SETTINGS,requireHome:true}};
 assert.deepEqual(gate({...strict,home:false}).reasons,['away_or_home_device_unreachable']);
 assert.equal(gate({...strict,home:true}).eligible,true);
});
test('explicit dashboard relaxation works without ignoring battery safety',()=>{
 const relaxed={...healthy,settings:{...DEFAULT_SETTINGS,requireHome:false,requireAC:false},home:false};
 assert.equal(gate({...relaxed,power:onBattery(80)}).eligible,true);
 assert.equal(gate({...relaxed,power:onBattery(20)}).eligible,false);
});
test('settings require strict fields and bounded integer values',()=>{assert.deepEqual(validateSettings(DEFAULT_SETTINGS),DEFAULT_SETTINGS);for(const s of [{...DEFAULT_SETTINGS,enabled:1},{...DEFAULT_SETTINGS,other:1},{...DEFAULT_SETTINGS,minBatteryPercent:9},{...DEFAULT_SETTINGS,minBatteryPercent:96},{...DEFAULT_SETTINGS,pollIntervalMinutes:0},{...DEFAULT_SETTINGS,pollIntervalMinutes:1.5},{...DEFAULT_SETTINGS,pollIntervalMinutes:61}])assert.throws(()=>validateSettings(s));});
test('home is observed even when it is not required, and picks the broker route',()=>{
 const runtime=fs.readFileSync(new URL('../macbook/runtime.mjs',import.meta.url),'utf8');
 assert.match(runtime,/const home=probeHome\?await atHome\(\):knownHome;/);
 assert.doesNotMatch(runtime,/settings\.requireHome\?/);
 const worker=fs.readFileSync(new URL('../macbook/worker.mjs',import.meta.url),'utf8');
 assert.match(worker,/lastHome=g\.home;/);
 for(const action of ['macbook-peek','macbook-claim'])assert.match(worker,new RegExp("'"+action+"',\\{plan\\},\\{\\.\\.\\.lastSettings,requireHome:lastHome\\}"));
});
test('home subnet detection excludes VPN and virtual interfaces',()=>{const row={family:'IPv4',address:'10.0.0.47',internal:false};assert(onPhysicalHomeNetwork('10.0.0.0/24',{en0:[row]}));assert(!onPhysicalHomeNetwork('10.0.0.0/24',{utun3:[row],bridge1:[row]}));assert(!onPhysicalHomeNetwork('10.0.0.0/24',{en0:[{...row,address:'192.168.1.5'}]}));});
test('native image adaptation preserves the production iMac harness',()=>{const root=path.resolve(new URL('..',import.meta.url).pathname),before=fs.readFileSync(path.join(root,'imac/container-check.cjs'),'utf8'),tmp=fs.mkdtempSync(path.join(os.tmpdir(),'macbook-context-'));try{const image=buildContext(tmp);assert.match(image,/^promptr-qa-macbook:[a-f0-9]{16}$/);const generated=fs.readFileSync(path.join(tmp,'imac/container-check.cjs'),'utf8');assert.match(generated,/macbook-docker-arm64/);assert.match(generated,/imac-pinned-ssh-fresh-download-relay/);assert.match(generated,/const downloadStart = relay.downloadStart/);assert.match(generated,/runTests\(/);assert.equal(fs.readFileSync(path.join(root,'imac/container-check.cjs'),'utf8'),before);assert.match(fs.readFileSync(path.join(tmp,'macbook/Dockerfile'),'utf8'),/arch=arm64/);}finally{fs.rmSync(tmp,{recursive:true,force:true});}});
