import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// No browser, dependencies, real requests, storage, or monitor writes.
const html = readFileSync(new URL('../docs/index.html', import.meta.url), 'utf8');
const source = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
assert.ok(source, 'dashboard inline script exists');
const NOW = Date.parse('2026-09-06T12:00:00Z');
const iso = offset => new Date(NOW + offset).toISOString();
const REPO = 'AryanSudhirDev/promptr-install-smoke-tests';
const API = 'https://promptr-qa-dashboard.vercel.app/api/settings';
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const json = value => ({ ok: true, status: 200, json: async () => structuredClone(value) });

class Element {
  constructor(document) {
    this.document = document;
    this.style = {}; this.attributes = {}; this.listeners = new Map();
    this.children = []; this.disabled = false; this.value = '';
    this.textContent = ''; this.innerHTML = ''; this.className = '';
    this.classList = { add() {}, remove() {}, toggle() {} };
  }
  set value(value) { this._value = String(value); }
  get value() { return this._value; }
  setAttribute(key, value) { this.attributes[key] = String(value); }
  getAttribute(key) { return this.attributes[key]; }
  append(...children) {
    this.children.push(...children);
    for (const child of children) if (child?.id) this.document.elements.set(child.id, child);
  }
  replaceChildren(...children) { this.children = []; this.innerHTML = ''; this.textContent = ''; this.append(...children); }
  querySelector(selector) { assert.equal(selector, 'summary'); return this.summary ??= new Element(this.document); }
  addEventListener(name, listener) { const list = this.listeners.get(name) || []; list.push(listener); this.listeners.set(name, list); }
  dispatch(name, event = {}) { for (const listener of this.listeners.get(name) || []) listener({ preventDefault() {}, ...event }); }
  focus() { this.document.activeElement = this; this.dispatch('focus'); }
  getBoundingClientRect() { return { left: 0, top: 0, width: 800, height: 200 }; }
}

async function dashboard({ blockedStorage = false, stored = {} } = {}) {
  const document = {
    elements: new Map(), hidden: false,
    listeners: new Map(),
    addEventListener(name, listener) { this.listeners.set(name, listener); },
    getElementById(id) { return this.elements.get(id) || null; },
    createElement() { return new Element(this); },
    createTextNode(text) { return { textContent: text }; }
  };
  for (const [, id] of html.matchAll(/\bid="([^"]+)"/g)) document.elements.set(id, new Element(document));
  document.body = new Element(document);
  const disk = new Map(Object.entries(stored)), timers = new Map(), calls = [];
  let timerId = 0;
  const state = {
    failures: new Set(), holds: new Map(), http: new Map(),
    status: { updatedAt: iso(0), github: { day: '2026-09-06', countsComplete: true, dailyTotal: 42, checksToday: 8, failedToday: 0, runsToday: 4, lastRunAt: iso(-60000) }, imac: { dailyTotal: 13 }, openvsx: { downloadCount: 1000, version: '1' } },
    live: { downloadCount: 900, version: '2', reviewCount: 3 },
    history: [{ at: iso(-86400000), downloadCount: 1000 }, { at: iso(-60000), downloadCount: 900 }],
    settings: { writable: true, repo: REPO, settings: { github: 50, imac: 20 } },
    postResponse: null
  };
  const route = (url, options) => options.method === 'POST' ? 'post' : url.includes('status.json') ? 'status' : url.includes('downloads.jsonl') ? 'history' : url.includes('open-vsx.org') ? 'live' : 'settings';
  async function fetch(url, options) {
    const kind = route(url, options);
    calls.push({ url, options, kind });
    // Capture the response at request start to model stale reads racing a write.
    const value = structuredClone(state[kind]);
    if (state.holds.has(kind)) await state.holds.get(kind).promise;
    if (state.failures.has(kind)) throw new Error(kind + ' unavailable');
    if (state.http.has(kind)) return { ok: false, status: state.http.get(kind), json: async () => { throw new Error('must not parse failed HTTP'); } };
    if (kind === 'post') {
      const body = JSON.parse(options.body);
      state.settings.settings[body.target] = body.total;
      return json(state.postResponse || { ok: true, ...body });
    }
    return kind === 'history' ? { ok: true, text: async () => value.map(p => JSON.stringify(p)).join('\n') } : json(value);
  }
  class Clock extends Date { constructor(...args) { super(...(args.length ? args : [NOW])); } static now() { return NOW; } }
  const context = vm.createContext({
    console, document, Date: Clock, AbortController, innerWidth: 1000, innerHeight: 800, fetch,
    localStorage: {
      getItem(key) { if (blockedStorage) throw new Error('blocked'); return disk.get(key) ?? null; },
      setItem(key, value) { if (blockedStorage) throw new Error('quota'); disk.set(key, value); },
      removeItem(key) { if (blockedStorage) throw new Error('blocked'); disk.delete(key); }
    },
    setTimeout(fn, ms) { const id = ++timerId; timers.set(id, { fn, ms }); return id; },
    clearTimeout(id) { timers.delete(id); },
    setInterval() {} // Polling is driven explicitly by each test.
  });
  const run = code => vm.runInContext(code, context);
  vm.runInContext(source, context, { filename: 'docs/index.html:inline' });
  await run('refreshing');
  return { run, state, calls, timers, context, disk, el: id => document.getElementById(id), refresh: () => run('refreshLive()') };
}

function enter(d, id, value) { d.el(id).value = value; d.el(id).dispatch('input'); }
function key(d) { d.el('token').value = 'test-dashboard-key'; d.run('saveToken()'); }

test('startup reads each source once; simultaneous refreshes do not overlap', async () => {
  const d = await dashboard();
  assert.deepEqual(d.calls.map(c => c.kind).sort(), ['history', 'live', 'settings', 'status']);
  const hold = deferred(); d.state.holds.set('live', hold);
  const start = d.calls.length;
  const one = d.refresh(), two = d.refresh();
  assert.equal(d.calls.length - start, 4);
  assert.equal(d.el('refresh').disabled, true);
  hold.resolve(); await Promise.all([one, two]);
  assert.equal(d.el('refresh').disabled, false);
  assert.equal(d.timers.size, 0);
});

test('source failures are independent and explicitly mark cached data', async () => {
  const d = await dashboard();
  d.state.failures.add('status');
  const count = d.calls.length; await d.refresh();
  assert.equal(d.calls.length - count, 4);
  assert.match(d.el('stamp').textContent, /Registry observed/);
  for (const source of ['history', 'live']) d.state.failures.add(source);
  await d.refresh();
  assert.match(d.el('stamp').textContent, /Live refresh failed.*Cached reading/);
  assert.match(d.el('chart-note').textContent, /History refresh failed/);
  assert.match(d.el('gh-stats').textContent, /Stale/);
  assert.ok(d.run('chartPoints.length') > 0);
});

test('authoritative settings override snapshots while dirty inputs survive refresh', async () => {
  const d = await dashboard();
  assert.equal(d.el('combined').textContent, '70');
  assert.equal(d.el('gh-total').value, '50');
  enter(d, 'gh-total', '77'); await d.refresh();
  assert.equal(d.el('gh-total').value, '77');
  assert.equal(d.el('combined').textContent, '70');
});

test('save locks both controls, deduplicates writes, updates labels, and awaits confirmation', async () => {
  const d = await dashboard(); key(d); enter(d, 'gh-total', '77');
  const hold = deferred(); d.state.holds.set('post', hold);
  const save = d.run('save("github")');
  assert.equal(d.el('gh-save').disabled, true);
  assert.equal(d.el('im-total').disabled, true);
  await d.run('save("github")');
  assert.equal(d.calls.filter(c => c.kind === 'post').length, 1);
  hold.resolve(); await save;
  assert.equal(d.el('combined').textContent, '97');
  assert.match(d.el('gh-need').textContent, /awaiting server confirmation/);
  d.state.settings.settings.github = null; await d.refresh();
  assert.equal(d.el('gh-total').value, '77');
  assert.equal(d.run('pending.github.value'), 77);
  d.state.settings.settings.github = 77; await d.refresh();
  assert.equal(d.run('pending.github'), null);
  assert.match(d.el('gh-msg').textContent, /confirmed/);
});

test('settings read begun before a save cannot roll back its accepted value', async () => {
  const d = await dashboard(); key(d); enter(d, 'gh-total', '77');
  const hold = deferred(); d.state.holds.set('settings', hold);
  const refresh = d.refresh(); await d.run('save("github")');
  hold.resolve(); await refresh;
  assert.equal(d.el('combined').textContent, '97');
  assert.equal(d.run('pending.github.value'), 77);
});

test('blocked storage falls back to memory; keys clear and GitHub credentials are rejected', async () => {
  const d = await dashboard({ blockedStorage: true }); key(d);
  assert.equal(d.run('dashboardKey()'), 'test-dashboard-key');
  assert.match(d.el('tok-msg').textContent, /memory|session/i);
  d.run('clearToken()'); assert.equal(d.run('dashboardKey()'), '');
  d.el('token').value = 'github_pat_TEST_NOT_A_REAL_TOKEN'; d.run('saveToken()');
  assert.equal(d.run('dashboardKey()'), '');
  assert.match(d.el('tok-msg').textContent, /not a GitHub token/);
  const saved = await dashboard({ stored: { promptr_qa_dash_key: 'ghp_TEST', promptr_qa_token: 'obsolete' } });
  assert.equal(saved.run('dashboardKey()'), '');
  assert.equal(saved.disk.has('promptr_qa_token'), false);
});

test('writes fail closed on API errors or wrong repo and route keys only to canonical API', async () => {
  const d = await dashboard(); key(d); enter(d, 'gh-total', '77'); await d.run('save("github")');
  const writes = d.calls.filter(c => c.options.headers?.['x-dash-key']);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].url, API);
  assert.equal(writes[0].options.redirect, 'error');
  assert.equal(writes[0].options.credentials, 'omit');
  for (const failure of ['unavailable', 'repo']) {
    d.state.failures.delete('settings');
    if (failure === 'unavailable') d.state.failures.add('settings');
    else d.state.settings.repo = 'other/repo';
    await d.refresh(); assert.equal(d.el('gh-save').disabled, true);
    const before = d.calls.length; await d.run('save("github")'); assert.equal(d.calls.length, before);
  }
});

test('HTTP failures and abort timeouts reject and clean timers', async () => {
  const d = await dashboard(); d.state.http.set('live', 503);
  await assert.rejects(d.run('fetchLive()'), /HTTP 503/);
  assert.equal(d.timers.size, 0);
  d.context.fetch = (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => { const error = new Error('aborted'); error.name = 'AbortError'; reject(error); });
  });
  const request = d.run('request("https://example.invalid")');
  assert.equal(d.timers.size, 1);
  const timer = [...d.timers.values()][0]; assert.equal(timer.ms, 15000); timer.fn();
  await assert.rejects(request, /timed out/); assert.equal(d.timers.size, 0);
});

test('invalid rates never POST; malformed save responses are not reported as confirmed', async () => {
  const d = await dashboard(); key(d);
  for (const value of ['', '1.5', '0', '1001', 'NaN']) { enter(d, 'gh-total', value); await d.run('save("github")'); }
  assert.equal(d.calls.filter(c => c.kind === 'post').length, 0);
  d.state.postResponse = { ok: true, target: 'imac', total: 77 };
  enter(d, 'gh-total', '77'); await d.run('save("github")');
  assert.match(d.el('gh-msg').textContent, /not confirmed/);
  assert.equal(d.run('pending.github'), null);
});

test('numbers and dates are sanitized before charts and status rendering', async () => {
  const d = await dashboard();
  for (const expression of ['count(Infinity)', 'count(NaN)', 'count(-1)', 'count("42")', 'timestamp("<img>")', 'timestamp("2099-01-01T00:00:00Z")']) assert.equal(d.run(expression), null);
  d.state.status.github.checksToday = '<img src=x onerror=alert(1)>';
  d.state.live.reviewCount = '<svg>';
  d.state.history.push({ at: '<script>', downloadCount: 200 }, { at: iso(-10), downloadCount: '999' });
  await d.refresh();
  assert.doesNotMatch(d.el('gh-stats').textContent, /<img/);
  assert.doesNotMatch(d.el('chart').innerHTML, /<script|NaN|Infinity/);
  assert.equal(d.el('extra').textContent, '');
});

test('incomplete publisher counts remain unknown, with UTC day and no healthy iMac claim', async () => {
  const d = await dashboard();
  Object.assign(d.state.status.github, { day: '2026-09-06', countsComplete: false, checksToday: null, failedToday: null, runsToday: null });
  await d.refresh();
  assert.match(d.el('today').textContent, /unknown/);
  assert.doesNotMatch(d.el('gh-dot').className, /\bok\b/);
  assert.doesNotMatch(d.el('im-dot').className, /\bok\b/);
  assert.match(d.el('im-stats').textContent, /Health unknown/);
  assert.match(d.el('gh-stats').textContent, /UTC/);
});

test('publisher github.day, not updatedAt, controls whether counts belong to today', async () => {
  const d = await dashboard(); d.state.status.github.day = '2026-09-05'; await d.refresh();
  assert.match(d.el('today').textContent, /unknown|stale/i);
});

test('decreases and unchanged observations survive; missing capture hours are unknown', async () => {
  const d = await dashboard();
  const original = d.run('livePoints()[0].at');
  d.run('addLivePoint({at:"2026-09-06T11:59:59Z",downloadCount:900,live:true})');
  assert.equal(d.run('livePoints().length'), 2);
  assert.equal(d.run('livePoints()[0].at'), original);
  assert.ok(d.run('chartPoints.some(p => p.label.includes("1,000"))'));
  assert.ok(d.run('barPoints.some(p => p.label.includes("-100"))'));
  assert.ok(d.run('barPoints.some(p => p.label.includes("unknown"))'));
  assert.match(d.el('chart-note').textContent, /later capture hour/);
  d.state.live.downloadCount = 800; await d.refresh();
  assert.ok(d.run('livePoints().some(p => p.downloadCount === 900)'));
});

test('keyboard tooltips include year and timezone; empty charts clear interaction state', async () => {
  const d = await dashboard();
  for (const id of ['chart', 'bars']) {
    assert.equal(d.el(id).getAttribute('tabindex'), '0');
    d.el(id).dispatch('focus'); assert.match(d.el('tip').textContent, /2026.*UTC/);
    d.el(id).dispatch('keydown', { key: 'End' }); assert.equal(d.el('tip').style.display, 'block');
    d.el(id).dispatch('keydown', { key: 'ArrowLeft' });
    d.el(id).dispatch('keydown', { key: 'Escape' }); assert.equal(d.el('tip').style.display, 'none');
  }
  d.run('drawHistory([]); drawProjection([])');
  assert.equal(d.run('chartPoints.length + barPoints.length'), 0);
  assert.equal(d.el('win').children.length, 0);
  assert.equal(d.el('bars').innerHTML, '');
  assert.equal(d.el('proj').children.length, 0);
  d.el('chart').dispatch('keydown', { key: 'ArrowRight' }); assert.equal(d.el('tip').style.display, 'none');
  assert.match(d.el('proj-note').textContent, /not a forecast or guarantee/);
});
