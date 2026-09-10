export const SLOT_MS = 5 * 60000;
export const SLOTS_PER_DAY = 288;
export const LOOKBACK_MS = 6 * 3600000;
const OFFSET = 2 * 60000;
export const validTotal = n => Number.isInteger(n) && n >= 1 && n <= 8000;
export const slotAt = ms => Math.floor((ms - OFFSET) / SLOT_MS) * SLOT_MS + OFFSET;
export function countForSlot(ms, total) {
  if (!validTotal(total)) throw new Error('daily total must be 1-8000');
  const date = new Date(ms), index = Math.floor((date.getUTCHours() * 60 + date.getUTCMinutes()) / 5);
  return Math.floor((index + 1) * total / SLOTS_PER_DAY) - Math.floor(index * total / SLOTS_PER_DAY);
}
export function initialState(now, total) {
  if (!validTotal(total)) throw new Error('invalid daily total');
  // Migration starts from now, without replaying jobs already handled by the old runner.
  return { version: 2, dailyTotal: total, lastEnqueuedAt: slotAt(now), jobs: {}, missedSlots: 0 };
}
export function advance(state, now, total) {
  if (state.version !== 2 || !validTotal(total) || !validTotal(state.dailyTotal) || !Number.isFinite(state.lastEnqueuedAt)) throw new Error('invalid scheduler state');
  const end = slotAt(now), floor = now - LOOKBACK_MS;
  let start = state.lastEnqueuedAt + SLOT_MS;
  if (start < floor) {
    const firstEligible = Math.ceil((floor - OFFSET) / SLOT_MS) * SLOT_MS + OFFSET;
    state.missedSlots += Math.max(0, (firstEligible - start) / SLOT_MS);
    start = firstEligible;
  }
  for (let ms = start; ms <= end; ms += SLOT_MS) {
    const count = countForSlot(ms, state.dailyTotal);
    for (let i = 0; i < count; i++) {
      const id = `v2-${new Date(ms).toISOString().replace(/[-:]/g, '').slice(0, 13)}-${i}`;
      state.jobs[id] ??= { id, slot: ms, index: i, plannedTotal: state.dailyTotal, status: 'pending' };
    }
  }
  state.lastEnqueuedAt = Math.max(state.lastEnqueuedAt, end);
  // Rate changes are forward-only. Already queued jobs retain the plan that created them.
  state.dailyTotal = total;
  for (const [id, job] of Object.entries(state.jobs)) {
    if (job.status === 'pending' && job.slot < floor) job.status = 'expired';
    if (job.slot < now - 7 * 86400000 && job.status !== 'started') delete state.jobs[id];
  }
  return state;
}
export function pendingJobs(state, limit = 100) {
  return Object.values(state.jobs).filter(j => j.status === 'pending').sort((a,b) => a.slot-b.slot || a.index-b.index).slice(0,limit);
}
