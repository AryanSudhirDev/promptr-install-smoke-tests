// Poll the effective VS Code setting after config.update() has resolved. This avoids
// unconditional sleeps without treating an unpropagated value as a successful check.
const {setTimeout: sleep} = require('node:timers/promises');
async function waitForSetting(read, expected, {
  timeoutMs = 2000, intervalMs = 20, now = () => performance.now(), pause = sleep,
} = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || !Number.isFinite(intervalMs) || intervalMs <= 0) throw new Error('Invalid setting wait bounds');
  const deadline = now() + timeoutMs;
  while (true) {
    const actual = read();
    if (Object.is(actual, expected)) return;
    const remaining = deadline - now();
    if (remaining <= 0) throw new Error(`Setting did not become ${JSON.stringify(expected)} within ${timeoutMs}ms (last value ${JSON.stringify(actual)})`);
    await pause(Math.min(intervalMs, remaining));
  }
}
module.exports = {waitForSetting};
