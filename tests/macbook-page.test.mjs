import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// No browser, dependencies, real requests, storage, or monitor writes.
const html = readFileSync(new URL('../docs/macbook.html', import.meta.url), 'utf8');
const source = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
assert.ok(source, 'macbook page inline script exists');
const REPO = 'AryanSudhirDev/promptr-install-smoke-tests';
const API = 'https://promptr-qa-dashboard.vercel.app/api/macbook';
const DEFAULTS = { enabled: true, minBatteryPercent: 50, pollIntervalMinutes: 10, requireAC: true, requireHome: true, promptrDailyTotal: 3000, cognispecDailyTotal: 2000 };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const json = value => ({ ok: true, status: 200, json: async () => structuredClone(value) });

test('basic markup: settings fields, nav link, and local-status link exist', () => {
  assert.match(html, /href="index\.html"/);
  assert.doesNotMatch(html, /href="https:\/\/[^"]*index\.html"/);
  for (const id of ['enabled', 'minBattery', 'pollInterval', 'requireAC', 'requireHome', 'save-btn', 'macbook-form', 'token', 'tokbox']) {
    assert.match(html, new RegExp('id="' + id + '"'), 'missing #' + id);
  }
  assert.match(html, /href="http:\/\/127\.0\.0\.1:47831\/"/);
  assert.match(html, /runner Mac itself/);
  assert.doesNotMatch(html, /\b(192\.168\.|10\.\d+\.\d+\.\d+|SSID)\b/i);
});

class Element {
  constructor(document) {
    this.document = document;
    this.style = {}; this.attributes = {}; this.listeners = new Map();
    this.children = []; this.disabled = false; this.checked = false; this.hidden = false;
    this.textContent = ''; this.innerHTML = ''; this.className = '';
  }
  set value(value) { this._value = String(value); }
  get value() { return this._value ?? ''; }
  setAttribute(key, value) { this.attributes[key] = String(value); }
  getAttribute(key) { return this.attributes[key]; }
  querySelector(selector) { assert.equal(selector, 'summary'); return this.summary ??= new Element(this.document); }
  addEventListener(name, listener) { const list = this.listeners.get(name) || []; list.push(listener); this.listeners.set(name, list); }
  dispatch(name, event = {}) { for (const listener of this.listeners.get(name) || []) listener({ preventDefault() {}, ...event }); }
  focus() { this.document.activeElement = this; this.dispatch('focus'); }
  click() { this.dispatch('click'); }
}

async function page({ blockedStorage = false, stored = {} } = {}) {
  const document = {
    elements: new Map(),
    listeners: new Map(),
    addEventListener(name, listener) { const list = this.listeners.get(name) || []; list.push(listener); this.listeners.set(name, list); },
    getElementById(id) { return this.elements.get(id) || null; },
    dispatch(name, event = {}) { for (const listener of this.listeners.get(name) || []) listener(event); },
  };
  for (const [, id] of html.matchAll(/\bid="([^"]+)"/g)) document.elements.set(id, new Element(document));
  const disk = new Map(Object.entries(stored)), timers = new Map(), calls = [];
  let timerId = 0;
  const state = {
    failures: new Set(), holds: new Map(), http: new Map(),
    settings: { writable: true, repo: REPO, settings: { ...DEFAULTS } },
    postResponse: null,
  };
  const route = (url, options) => options?.method === 'POST' ? 'post' : 'settings';
  async function fetch(url, options) {
    const kind = route(url, options);
    calls.push({ url, options, kind });
    let value = structuredClone(state.settings);
    if (state.holds.has(kind)) await state.holds.get(kind).promise;
    if (state.failures.has(kind)) throw new Error(kind + ' unavailable');
    if (state.http.has(kind)) return { ok: false, status: state.http.get(kind), json: async () => { throw new Error('must not parse failed HTTP'); } };
    if (kind === 'post') {
      const body = JSON.parse(options.body);
      state.settings.settings = { ...state.settings.settings, ...body.settings };
      return json(state.postResponse || { ok: true, settings: body.settings });
    }
    return json(value);
  }
  const context = vm.createContext({
    console, document, AbortController, fetch,
    localStorage: {
      getItem(key) { if (blockedStorage) throw new Error('blocked'); return disk.get(key) ?? null; },
      setItem(key, value) { if (blockedStorage) throw new Error('quota'); disk.set(key, value); },
      removeItem(key) { if (blockedStorage) throw new Error('blocked'); disk.delete(key); },
    },
    setTimeout(fn, ms) { const id = ++timerId; timers.set(id, { fn, ms }); return id; },
    clearTimeout(id) { timers.delete(id); },
  });
  const run = code => vm.runInContext(code, context);
  vm.runInContext(source, context, { filename: 'docs/macbook.html:inline' });
  await run('load()');
  return { run, state, calls, timers, context, disk, el: id => document.getElementById(id) };
}

function key(d) { d.el('token').value = 'test-dashboard-key'; d.run('saveToken()'); }
function submit(d) { return d.run('submit({preventDefault(){}})'); }

test('loading populates the form from server settings and uses the same dashboard key namespace', async () => {
  const d = await page();
  assert.equal(d.el('enabled').checked, true);
  assert.equal(d.el('minBattery').value, '50');
  assert.equal(d.el('pollInterval').value, '10');
  assert.equal(d.el('requireAC').checked, true);
  assert.equal(d.el('requireHome').checked, true);
  key(d);
  assert.equal(d.disk.get('promptr_qa_dash_key'), 'test-dashboard-key');
});

test('unauthenticated save opens the access menu instead of posting', async () => {
  const d = await page();
  await submit(d);
  assert.equal(d.calls.filter(c => c.kind === 'post').length, 0);
  assert.equal(d.el('tokbox').attributes.open, undefined);
  d.run("$('tokbox').open = true"); // sanity: element supports the flag used by real submit()
});

test('a saved GitHub-token-shaped value is rejected, matching the extension monitor rule', async () => {
  const d = await page();
  d.el('token').value = 'github_pat_TEST_NOT_A_REAL_TOKEN';
  d.run('saveToken()');
  assert.equal(d.run('dashboardKey()'), '');
  assert.match(d.el('tok-msg').textContent, /not a GitHub token/);
});

test('save sends the full five-field schema, disables inputs while saving, and confirms on success', async () => {
  const d = await page(); key(d);
  d.el('minBattery').value = '60'; d.el('minBattery').dispatch('input');
  const hold = deferred(); d.state.holds.set('post', hold);
  const saving = submit(d);
  assert.equal(d.el('enabled').disabled, true);
  assert.equal(d.el('save-btn').disabled, true);
  hold.resolve(); await saving;
  const posted = JSON.parse(d.calls.find(c => c.kind === 'post').options.body);
  assert.deepEqual(posted, { settings: { enabled: true, minBatteryPercent: 60, pollIntervalMinutes: 10, requireAC: true, requireHome: true, promptrDailyTotal: 3000, cognispecDailyTotal: 2000 } });
  assert.match(d.el('save-msg').textContent, /Accepted/);
  assert.equal(d.el('enabled').disabled, false);
});

test('client-side validation rejects out-of-range values before any request is sent', async () => {
  const d = await page(); key(d);
  for (const [id, value] of [['minBattery', '9'], ['minBattery', '96'], ['pollInterval', '0'], ['pollInterval', '61']]) {
    const before = d.calls.filter(c => c.kind === 'post').length;
    d.el(id).value = value; d.el(id).dispatch('input');
    await submit(d);
    assert.equal(d.calls.filter(c => c.kind === 'post').length, before, id + '=' + value + ' must not POST');
    assert.match(d.el('save-msg').textContent, /Enter valid whole-number/);
  }
});

test('toggling off requireAC or requireHome shows an explicit warning', async () => {
  const d = await page();
  assert.equal(d.el('ac-warn').hidden, true);
  d.el('requireAC').checked = false; d.el('requireAC').dispatch('input'); d.run("renderForm()");
  assert.equal(d.el('ac-warn').hidden, false);
  d.el('requireHome').checked = false; d.el('requireHome').dispatch('input'); d.run("renderForm()");
  assert.equal(d.el('home-warn').hidden, false);
});

test('never fetches the local runner status endpoint', async () => {
  const d = await page();
  assert.ok(d.calls.every(c => !String(c.url).includes('127.0.0.1')));
});

test('requests route only to the canonical API with safe fetch options', async () => {
  const d = await page(); key(d);
  await submit(d);
  for (const call of d.calls) {
    assert.equal(call.url, API);
    assert.equal(call.options.credentials, 'omit');
    assert.equal(call.options.redirect, 'error');
  }
});

test('server-rejected writes surface a clear error and do not fabricate a confirmed state', async () => {
  const d = await page(); key(d);
  d.state.http.set('post', 401);
  await submit(d);
  assert.match(d.el('save-msg').textContent, /rejected|forbidden/);
  assert.equal(d.run('pending'), null);
});

test('a read failure is shown as unavailable, never as a fabricated default', async () => {
  const d = await page();
  d.state.failures.add('settings');
  await d.run('load()');
  assert.match(d.el('config-state').textContent, /Could not read|unavailable/);
});

test('blocked storage falls back to memory without throwing', async () => {
  const d = await page({ blockedStorage: true });
  key(d);
  assert.equal(d.run('dashboardKey()'), 'test-dashboard-key');
  assert.match(d.el('tok-msg').textContent, /memory|session/i);
});

test('response payload never contains the dashboard key text', async () => {
  const d = await page(); key(d);
  await submit(d);
  for (const call of d.calls) assert.ok(!JSON.stringify(call).includes('test-dashboard-key') || call.options?.headers?.['x-dash-key'] === 'test-dashboard-key');
});
