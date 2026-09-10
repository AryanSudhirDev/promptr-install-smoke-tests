import test from 'node:test';
import assert from 'node:assert/strict';
import {countForSlot, initialState, advance, pendingJobs, SLOT_MS, slotAt} from '../imac/schedule.mjs';
const day=Date.parse('2026-09-10T00:02:00Z');
test('every supported daily total produces its exact count over 288 slots',()=>{
  for(let total=1;total<=1000;total++){
    let sum=0;for(let i=0;i<288;i++)sum+=countForSlot(day+i*SLOT_MS,total);
    assert.equal(sum,total);
  }
});
test('780 uses 2-3 checks per five-minute slot; 1000 never exceeds four',()=>{
  for(let i=0;i<288;i++) {assert.ok([2,3].includes(countForSlot(day+i*SLOT_MS,780))); assert.ok(countForSlot(day+i*SLOT_MS,1000)<=4);}
});
test('new installation does not replay old work',()=>{
  const s=initialState(day,780);advance(s,day,780);assert.equal(pendingJobs(s).length,0);
});
test('batch limits leave jobs queued and never discard a whole slot',()=>{
  const s=initialState(day,780);advance(s,day+12*SLOT_MS,780);
  const all=pendingJobs(s,1000);assert.ok(all.length>6);
  for(const j of pendingJobs(s,6))j.status='passed';
  assert.equal(pendingJobs(s,1000).length,all.length-6);
  advance(s,day+12*SLOT_MS,780);assert.equal(pendingJobs(s,1000).length,all.length-6);
});
test('changing the rate affects only future slots',()=>{
  const s=initialState(day,90);advance(s,day+SLOT_MS,780);
  const old=pendingJobs(s,1000).length;advance(s,day+2*SLOT_MS,780);
  assert.equal(pendingJobs(s,1000).length,old+countForSlot(day+2*SLOT_MS,780));
});
test('stale work expires visibly and an offline gap is recorded',()=>{
  const s=initialState(day,780);advance(s,day+SLOT_MS,780);advance(s,day+24*3600000,780);
  assert.ok(s.missedSlots>0);assert.ok(Object.values(s.jobs).some(j=>j.status==='expired'));
  assert.ok(pendingJobs(s,1000).every(j=>j.slot>=day+18*3600000));
});
test('slot IDs are unique across midnight and repeated invocations',()=>{
  const now=day+287*SLOT_MS,s=initialState(now,1000);advance(s,now+2*SLOT_MS,1000);
  const n=Object.keys(s.jobs).length;assert.ok(n>=6);advance(s,now+2*SLOT_MS,1000);assert.equal(Object.keys(s.jobs).length,n);
  assert.equal(slotAt(day+1),day);
});
