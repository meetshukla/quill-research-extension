const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const root = path.resolve(__dirname, '..');
test('bundled generic voice templates match their integrity manifest', async () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'voice/manifest.json'), 'utf8'));
  for (const name of ['profile', 'opinions']) {
    const bytes = fs.readFileSync(path.join(root, `voice/${name}.md`));
    const digest = Buffer.from(await webcrypto.subtle.digest('SHA-256', bytes)).toString('hex');
    assert.equal(digest, manifest[name]);
  }
});
const post = (id = '1', text = 'How do you debug an AI product?') => ({ type: 'POST', url: `https://x.com/author/status/${id}`, text, raw: { media: [], capturedAt: 'original' }, reply: 'my existing draft', replyRevision: 3 });
const payload = (relevant = .9, opportunity = .8, missingContext = .1) => ({ model: 'typesafe-ai/jev', answers: Object.fromEntries(Object.entries({ relevant, opportunity, missingContext }).map(([key, probability]) => [key, { type: 'boolean', probability }])) });
function harness(extra = {}, response = async () => ({ ok: true, json: async () => payload() }), clockStep = 3000) {
  let clock = Date.now();
  class TestDate extends Date { constructor(...args) { super(...(args.length ? args : [clock])); } static now() { return clock; } }
  const data = { modelDefaultRevision: '3.8', geminiModel: 'gemini-3.8-flash', geminiApiKey: 'test-google-key', jevGatewayKey: 'test-gateway-key', jevSettings: { enabled: true, feed: true, brief: 'AI products', dailyLimit: 200 }, replyCandidatesV1: { items: [post()], revision: 7, recovered: { legacy: 'kept' } }, voiceOverrides: { profile: 'test profile', opinions: 'test opinions', hashes: {} }, ...extra };
  const calls = [], listeners = [];
  const storage = {
    setAccessLevel: async () => {},
    get: async keys => structuredClone(Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter(key => data[key] !== undefined).map(key => [key, data[key]]))),
    set: async update => Object.assign(data, structuredClone(update)),
    remove: async key => { delete data[key]; }
  };
  const context = vm.createContext({ console, Date: TestDate, URL, TextEncoder, crypto: webcrypto, AbortSignal, setTimeout, clearTimeout,
    chrome: { storage: { local: storage }, sidePanel: { setPanelBehavior() {} }, runtime: { id: 'test-extension', getURL: file => `chrome-extension://test-extension/${file}`, onMessage: { addListener: fn => listeners.push(fn) } } },
    fetch: async (url, options) => { calls.push({ url, options, at: clock }); const result = await response(url, options); clock += clockStep; return result; }
  });
  context.importScripts = (...files) => files.forEach(file => vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), context));
  vm.runInContext(fs.readFileSync(path.join(root, 'background.js'), 'utf8'), context);
  const run = code => vm.runInContext(code, context);
  const message = (msg, sender = { id: 'test-extension', url: 'chrome-extension://test-extension/sidebar.html' }) => new Promise(resolve => listeners[0](msg, sender, resolve));
  return { data, calls, run, context, message, advance: ms => { clock += ms; } };
}
test('Jev uses the evaluation endpoint and only its own key/model; ranking never rewrites tweets or drafts', async () => {
  const h = harness(), before = structuredClone(h.data.replyCandidatesV1);
  const result = await h.run("evaluateSavedJev('https://x.com/author/status/1')");
  assert.equal(result.label, 'Relevant');
  assert.deepEqual(h.data.replyCandidatesV1, before);
  assert.equal(h.calls[0].url, 'https://ai-gateway.vercel.sh/v1/evaluate');
  assert.equal(h.calls[0].options.headers.Authorization, 'Bearer test-gateway-key');
  const body = JSON.parse(h.calls[0].options.body);
  assert.equal(body.model, 'typesafe-ai/jev');
  assert.deepEqual(body.providerOptions.gateway, { only: ['typesafe-ai'], zeroDataRetention: true });
  assert.equal(Object.keys(body.questions).length, 3);
  assert.doesNotMatch(h.calls[0].options.body, /test-google-key|my existing draft|test profile|capturedAt/);
});
test('Gemini generation still calls Google directly with only the Google key', async () => {
  const h = harness({}, async () => ({ ok: true, json: async () => ({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'what did the trace show?' }] } }] }) }));
  await h.run("requestReply({type:'POST',url:'https://x.com/author/status/1',text:'debug this AI product'})");
  assert.match(h.calls[0].url, /^https:\/\/generativelanguage.googleapis.com\//);
  assert.equal(h.calls[0].options.headers['x-goog-api-key'], 'test-google-key');
  assert.equal(h.calls[0].options.headers.Authorization, undefined);
});
test('standard data handling is explicit, never silently enabled after ZDR failure', async () => {
  const h = harness();
  assert.equal((await h.run('jevSettings()')).zeroDataRetention, true);
  await h.run("saveJevSettings({brief:'AI',enabled:true,feed:true,dailyLimit:200,zeroDataRetention:false})");
  assert.equal(h.data.jevSettings.feed, false);
  await h.run('testJevConnection()');
  assert.deepEqual(JSON.parse(h.calls[0].options.body).providerOptions.gateway, { only: ['typesafe-ai'] });
  await h.run('setJevView({hideIrrelevant:true})');
  assert.equal((await h.run('jevSettings()')).zeroDataRetention, false);
});
test('disabled by default with no calls, even if a source asks to enable it', async () => {
  const h = harness({ jevSettings: undefined });
  await assert.rejects(h.run("evaluateSavedJev('https://x.com/author/status/1')"), /off/);
  assert.equal(h.calls.length, 0);
});
test('same source and rubric reuse cache; reply edits do not invalidate it', async () => {
  const h = harness();
  await h.run("evaluateSavedJev('https://x.com/author/status/1')");
  await h.run("editCandidate('https://x.com/author/status/1','newer draft')");
  assert.equal((await h.run("evaluateSavedJev('https://x.com/author/status/1')")).cached, true);
  assert.equal(h.calls.length, 1);
  assert.equal(h.data.replyCandidatesV1.items[0].reply, 'newer draft');
});
test('changed interests and source text invalidate scores', async () => {
  const h = harness();
  await h.run("evaluateSavedJev('https://x.com/author/status/1')");
  h.data.jevSettings.brief = 'Gardening';
  assert.equal((await h.run('listCandidates().then(listWithJev)')).items[0].jev, undefined);
  await h.run("evaluateSavedJev('https://x.com/author/status/1')");
  h.data.replyCandidatesV1.items[0].text += ' expanded';
  assert.equal((await h.run('listCandidates().then(listWithJev)')).items[0].jev, undefined);
  await h.run("evaluateSavedJev('https://x.com/author/status/1')");
  assert.equal(h.calls.length, 3);
});
test('low relevance never removes saved tweets; uncertain and truncated sources stay for review', async () => {
  const h = harness({}, async () => ({ ok: true, json: async () => payload(.05, .2, .05) }));
  const result = await h.run("evaluateSavedJev('https://x.com/author/status/1')");
  assert.equal(result.selected, false);
  assert.equal(h.data.replyCandidatesV1.items.length, 1);
  h.context.body = payload(.45, .2, .2);
  assert.equal(h.run("parseJev(body,{text:'ambiguous',truncated:false}).selected"), true);
  h.context.body = payload(.01, .01, 0);
  assert.equal(h.run("parseJev(body,{text:'incomplete',truncated:true}).label"), 'Review');
});
test('malformed probabilities and a different model are rejected', async () => {
  const h = harness();
  for (const value of [-.1, 1.1, NaN, Infinity, '0.9', null, undefined]) {
    h.context.body = payload(value);
    // Undefined uses the fixture default; explicitly replace it here.
    h.context.body.answers.relevant.probability = value;
    assert.throws(() => h.run("parseJev(body,{text:'post'})"), /invalid probability/);
  }
  h.context.body = { ...payload(), model: 'google/gemini' };
  assert.throws(() => h.run("parseJev(body,{text:'post'})"), /unexpected model/);
});
test('config never returns keys and untrusted messages cannot rank or change settings', async () => {
  const h = harness();
  const config = await h.message({ type: 'QUILL_JEV_CONFIG' });
  assert.equal(config.data.keyConfigured, true);
  assert.doesNotMatch(JSON.stringify(config), /test-gateway-key|test-google-key/);
  const sender = { id: 'test-extension', url: 'https://x.com/home', tab: { id: 1 }, frameId: 0 };
  for (const type of ['QUILL_JEV_HEALTH', 'QUILL_JEV_TEST', 'QUILL_JEV_SET_VIEW', 'QUILL_JEV_CONFIG', 'QUILL_JEV_SAVE', 'QUILL_JEV_CLEAR_KEY', 'QUILL_JEV_RANK']) assert.equal((await h.message({ type }, sender)).ok, false);
  assert.equal((await h.message({ type: 'QUILL_JEV_FEED', source: post() }, { ...sender, frameId: 2 })).ok, false);
  assert.equal((await h.message({ type: 'QUILL_JEV_FEED', source: post() }, { ...sender, url: 'https://evil.example' })).ok, false);
  assert.equal(h.calls.length, 0);
});
test('daily cap persists and serial concurrent requests cannot exceed it', async () => {
  const h = harness({ jevSettings: { enabled: true, feed: true, brief: 'AI', dailyLimit: 1 } });
  h.context.first = post('1'); h.context.second = post('2');
  const results = await Promise.allSettled([h.run('evaluateJev(first)'), h.run('evaluateJev(second)')]);
  assert.equal(results[0].status, 'fulfilled'); assert.equal(results[1].status, 'rejected');
  assert.equal(h.calls.length, 1); assert.equal(h.data.jevUsage.requests, 1);
  assert.equal((await h.run('evaluateJev(first)')).cached, true);
});
test('HTTP errors persist a shared pause, consume one attempt, and keep saved data', async () => {
  const h = harness({}, async () => ({ ok: false, status: 401 }));
  const before = structuredClone(h.data.replyCandidatesV1);
  await assert.rejects(h.run("evaluateSavedJev('https://x.com/author/status/1')"));
  await assert.rejects(h.run("evaluateSavedJev('https://x.com/author/status/1')"), /paused/);
  assert.equal(h.data.jevHealthV1.state, 'paused');
  const restarted = harness(structuredClone(h.data));
  await assert.rejects(restarted.run("evaluateSavedJev('https://x.com/author/status/1')"), /paused/);
  assert.equal(restarted.calls.length, 0);
  assert.equal(h.calls.length, 1); assert.equal(h.data.jevUsage.requests, 1);
  assert.deepEqual(h.data.replyCandidatesV1, before);
});
test('request pacing persists across worker restarts and probes cannot bypass it', async () => {
  const h = harness({}, undefined, 0);
  await h.run('testJevConnection()');
  await assert.rejects(h.run('testJevConnection()'), error => error.code === 'jev_wait' && error.retryAt > Date.now());
  assert.equal(h.calls.length, 1); assert.equal(h.data.jevUsage.requests, 1);
  const restarted = harness(structuredClone(h.data), undefined, 0);
  await assert.rejects(restarted.run('testJevConnection()'), error => error.code === 'jev_wait');
  assert.equal(restarted.calls.length, 0);
  restarted.advance(2500);
  await restarted.run('testJevConnection()');
  assert.equal(restarted.calls.length, 1);
});
test('429 respects Retry-After without consuming attempts during cooldown', async () => {
  const h = harness({}, async () => ({ ok: false, status: 429, headers: { get: () => '90' } }), 0);
  const before = structuredClone(h.data.replyCandidatesV1);
  await assert.rejects(h.run('testJevConnection()'), error => error.code === 'jev_wait');
  assert.equal(h.data.jevHealthV1.state, 'waiting');
  h.advance(60000);
  await assert.rejects(h.run('testJevConnection()'), error => error.code === 'jev_wait');
  assert.equal(h.calls.length, 1); assert.equal(h.data.jevUsage.requests, 1);
  assert.deepEqual(h.data.replyCandidatesV1, before);
});
test('an in-flight evaluation cannot resurrect a deleted post or overwrite a reply edit', async () => {
  let release;
  const h = harness({}, () => new Promise(resolve => { release = () => resolve({ ok: true, json: async () => payload() }); }));
  const task = h.run("evaluateSavedJev('https://x.com/author/status/1')");
  while (!release) await new Promise(resolve => setImmediate(resolve));
  await h.run("editCandidate('https://x.com/author/status/1','do not overwrite')");
  await h.run('clearCandidates()'); release(); await task;
  assert.equal(h.data.replyCandidatesV1.items.length, 0);
  assert.deepEqual(h.data.replyCandidatesV1.recovered, { legacy: 'kept' });
});
test('disabling Jev while a request is in flight discards the result', async () => {
  let release;
  const h = harness({}, () => new Promise(resolve => { release = () => resolve({ ok: true, json: async () => payload() }); }));
  const task = h.run("evaluateSavedJev('https://x.com/author/status/1')");
  while (!release) await new Promise(resolve => setImmediate(resolve));
  await h.run('clearJevKey()'); release();
  await assert.rejects(task, /settings changed/);
  assert.equal(h.data.jevAssessmentsV1, undefined);
  assert.equal(h.data.geminiApiKey, 'test-google-key');
  assert.equal(h.data.replyCandidatesV1.items.length, 1);
});
test('page-supplied scores are ignored and disabled Jev is enforced in the worker', async () => {
  const h = harness();
  h.data.replyCandidatesV1.items[0].jev = { rank: 100, selected: true };
  assert.equal((await h.run('listCandidates().then(listWithJev)')).items[0].jev, undefined);
  h.data.jevSettings.enabled = false; h.context.source = post();
  await assert.rejects(h.run('evaluateJev(source,true)'), /off/);
  assert.equal(h.calls.length, 0);
});
test('settings validation preserves existing Gemini and tweet storage', async () => {
  const h = harness();
  await assert.rejects(h.run("saveJevSettings({brief:'',enabled:true,feed:true,dailyLimit:200})"), /brief/);
  await assert.rejects(h.run("saveJevSettings({brief:'AI',enabled:true,feed:true,dailyLimit:1001})"), /limit/);
  await h.run("saveJevSettings({brief:'Developer tools',enabled:true,feed:false,dailyLimit:50,key:''})");
  assert.equal(h.data.jevGatewayKey, 'test-gateway-key');
  assert.equal(h.data.geminiApiKey, 'test-google-key');
  assert.equal(h.data.replyCandidatesV1.items[0].reply, 'my existing draft');
});
test('topic fit alone determines selection and ranking, not reply opportunity', () => {
  const h = harness(); h.context.body = payload(.92, .01, .05);
  const result = h.run("parseJev(body,{text:'A relevant product launch'})");
  assert.equal(result.selected, true); assert.equal(result.label, 'Relevant'); assert.equal(result.rank, 92);
});
test('content scripts receive only safe view settings, and hide switch does not touch tweets or Google', async () => {
  const h = harness();
  const sender = { id: 'test-extension', url: 'https://x.com/home', tab: { id: 1 }, frameId: 0 };
  const response = await h.message({ type: 'QUILL_JEV_VIEW_CONFIG' }, sender);
  assert.deepEqual(Object.keys(response.data).sort(), ['enabled', 'hideIrrelevant', 'paused', 'revision', 'watch']);
  assert.doesNotMatch(JSON.stringify(response.data), /test-gateway-key|test-google-key|AI products/);
  assert.equal(response.data.watch, false, 'legacy saved feed=true cannot auto-start a new page');
  const before = structuredClone(h.data.replyCandidatesV1);
  await h.run('setJevView({watch:true,hideIrrelevant:true})');
  assert.equal(h.data.jevSettings.hideIrrelevant, true);
  assert.deepEqual(h.data.replyCandidatesV1, before); assert.equal(h.data.geminiApiKey, 'test-google-key');
});
test('connection probe bypasses pause/cache, is metered, and never writes tweet data', async () => {
  const h = harness({ jevHealthV1: { state: 'paused', message: 'old error' } });
  const before = structuredClone(h.data.replyCandidatesV1);
  const response = await h.message({ type: 'QUILL_JEV_TEST' });
  assert.equal(response.ok, true); assert.equal(response.data.state, 'ready');
  assert.equal(h.calls.length, 1); assert.equal(h.data.jevUsage.requests, 1);
  assert.equal(h.data.jevAssessmentsV1, undefined);
  assert.deepEqual(h.data.replyCandidatesV1, before);
  assert.doesNotMatch(h.calls[0].options.body, /existing draft|debug an AI product/);
  await h.message({ type: 'QUILL_JEV_TEST' });
  assert.equal(h.calls.length, 2);
});
test('UI toggles cannot clear a service failure; replacing the key can', async () => {
  const h = harness({ jevHealthV1: { state: 'paused', message: 'rejected' } });
  await h.run('setJevView({watch:true,hideIrrelevant:true})');
  assert.equal(h.data.jevHealthV1.state, 'paused');
  await h.run("saveJevSettings({brief:'AI',enabled:true,feed:true,dailyLimit:200,key:'new-test-key'})");
  assert.equal(h.data.jevHealthV1.state, 'unchecked');
});
test('provider diagnostics are retained for the sidebar and redact the key', async () => {
  const h = harness({}, async () => ({ ok: false, status: 400, json: async () => ({ error: { message: 'Invalid field with test-gateway-key' } }) }));
  const result = await h.message({ type: 'QUILL_JEV_TEST' });
  assert.equal(result.ok, false); assert.match(result.error, /HTTP 400.*Invalid field/);
  assert.doesNotMatch(result.error, /test-gateway-key/);
  assert.equal(h.data.jevHealthV1.httpStatus, 400);
  const content = await h.message({ type: 'QUILL_JEV_FEED', source: post() }, { id: 'test-extension', url: 'https://x.com/home', tab: { id: 1 }, frameId: 0 });
  assert.equal(content.code, 'jev_paused'); assert.doesNotMatch(content.error, /Invalid field/);
});
test('the old generic preset becomes the requested niche brief; custom interests survive', async () => {
  const h = harness();
  h.data.jevSettings.brief = h.run('JEV_LEGACY_BRIEF');
  const upgraded = await h.run('jevConfig()');
  assert.match(upgraded.brief, /yapping/); assert.match(upgraded.brief, /e-commerce/); assert.match(upgraded.brief, /reaction videos/);
  h.data.jevSettings.brief = 'My custom creative focus';
  assert.equal((await h.run('jevConfig()')).brief, 'My custom creative focus');
});
