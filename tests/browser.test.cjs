// Run with Playwright installed, or QUILL_PLAYWRIGHT pointing to its package.
// Every browser request is intercepted. No real X, Gateway, Gemini, or profile data.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.QUILL_PLAYWRIGHT || 'playwright');
const root = path.resolve(__dirname, '..');
let browser;
async function pageFor(html) {
  browser ||= await chromium.launch({ headless: true, ...(process.env.QUILL_BROWSER ? { executablePath: process.env.QUILL_BROWSER } : {}) });
  const context = await browser.newContext({ viewport: { width: 420, height: 900 } });
  await context.route('**/*', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: html }));
  const page = await context.newPage();
  await page.goto('https://x.com/home');
  return { page, context };
}
after(async () => { await browser?.close(); });
const article = (id, text) => `<article style="display:flex;flex-direction:row;padding:12px 16px;border-bottom:1px solid #2f3336;box-sizing:border-box"><div style="flex:1;min-width:0;display:flex;gap:12px"><div style="flex:0 0 40px;width:40px;height:40px;border-radius:50%;background:#323844"></div><div class="tweet-body" style="flex:1;min-width:0"><a style="color:#999;text-decoration:none" href="https://x.com/author/status/${id}"><strong style="color:white">Creator</strong> @author · <time datetime="2026-09-19">2h</time></a><div data-testid="tweetText" style="padding:6px 0 18px;line-height:1.5">${text}</div><div role="group" style="display:flex;align-items:center;justify-content:space-between;min-width:0;color:#71767b"><button data-testid="reply" style="background:none;color:inherit;border:0;padding:0">↩</button><span>⇄</span><span>♡</span><span>▥</span><span>♧</span></div></div></div></article>`;
async function feedFixture(html, options = {}) {
  const fixture = await pageFor(`<body style="margin:0;background:#111;color:#eee;font:15px system-ui">${html}</body>`), { page } = fixture;
  await page.evaluate(options => {
    window.saved = []; window.evaluated = []; window.listeners = []; window.delayEvaluation = options.delay || false;
    window.viewConfig = { enabled: options.enabled !== false, watch: options.watch || false, hideIrrelevant: options.hide || false, revision: 'brief-v1' };
    window.chrome = { runtime: { id: 'test', onMessage: { addListener: fn => listeners.push(fn) }, sendMessage: async message => {
      if (message.type === 'QUILL_GET_RULES') return { ok: true, data: { rules: [] } };
      if (message.type === 'QUILL_JEV_VIEW_CONFIG') return { ok: true, data: { ...viewConfig } };
      if (message.type === 'QUILL_SAVE_CANDIDATES') { saved.push(...message.items); return { ok: true, data: { saved: message.items.length } }; }
      if (message.type === 'QUILL_JEV_FEED') {
        evaluated.push(message.source.text);
        if (options.wait && evaluated.length === 1) return { ok: false, error: 'Rate limit cooldown', code: 'jev_wait', retryAt: Date.now() + 1000 };
        if (delayEvaluation) await new Promise(resolve => { window.releaseEvaluation = resolve; });
        if (message.source.text.includes('outage')) { viewConfig.paused = true; return { ok: false, error: 'Gateway offline', code: 'jev_paused' }; }
        const low = message.source.text.includes('unrelated'), review = message.source.text.includes('uncertain');
        return { ok: true, data: { selected: !low, label: low ? 'Low relevance' : review ? 'Review' : 'Relevant', relevant: low ? .05 : review ? .4 : .92, opportunity: .1, missingContext: review ? .7 : .05, rank: low ? 5 : 92 } };
      }
      throw Error('Unexpected message ' + message.type);
    } } };
    window.command = extra => new Promise(resolve => listeners[0]({ type: 'QUILL_COMMAND', ...extra }, { id: 'test' }, resolve));
    window.configChanged = () => new Promise(resolve => listeners[0]({ type: 'QUILL_JEV_SETTINGS_CHANGED' }, { id: 'test' }, resolve));
  }, options);
  await page.addStyleTag({ path: path.join(root, 'content.css') });
  await page.addScriptTag({ path: path.join(root, 'relevance.js') });
  await page.addScriptTag({ path: path.join(root, 'content.js') });
  if (options.watch) await page.evaluate(() => command({ action: 'analyze' }));
  return fixture;
}
test('loading, scrolling, and changing Hide never start analysis, even with the legacy feed preference on', async () => {
  const { page, context } = await feedFixture(article(1, 'Creator demo'), { hide: true });
  await page.evaluate(() => { viewConfig.watch = true; return configChanged(); });
  await page.evaluate(() => window.dispatchEvent(new Event('scroll')));
  await page.waitForTimeout(450);
  assert.equal(await page.evaluate(() => evaluated.length), 0);
  assert.equal(await page.evaluate(async () => (await command({ action: 'status' })).data.analysis.running), false);
  await page.evaluate(() => command({ action: 'analyze' }));
  await page.waitForSelector('.quill-relevance-chip:visible');
  assert.equal(await page.evaluate(() => evaluated.length), 1);
  assert.equal(await page.evaluate(() => saved.length), 0);
  await page.evaluate(() => command({ action: 'stop-analysis' }));
  await page.evaluate(html => document.body.insertAdjacentHTML('beforeend', html), article(2, 'Another creator demo'));
  await page.evaluate(() => window.dispatchEvent(new Event('scroll')));
  await page.waitForTimeout(450);
  assert.equal(await page.evaluate(() => evaluated.length), 1);
  assert.equal(await page.evaluate(async () => (await command({ action: 'status' })).data.analysis.running), false);
  await context.close();
});
test('Stop analyzing drops queued work and cannot paint a late result', async () => {
  const { page, context } = await feedFixture(article(1, 'unrelated first') + article(2, 'second'), { watch: true, delay: true, hide: true });
  await page.waitForFunction(() => Boolean(window.releaseEvaluation));
  await page.evaluate(() => command({ action: 'stop-analysis' }));
  await page.evaluate(() => releaseEvaluation());
  await page.waitForTimeout(350);
  assert.equal(await page.evaluate(() => evaluated.length), 1);
  assert.equal(await page.locator('.quill-relevance-chip:visible').count(), 0);
  assert.equal(await page.locator('.quill-collapsed').count(), 0);
  await context.close();
});
test('one click freezes a batch, applies results together and automatically finishes', async () => {
  const { page, context } = await feedFixture(article(1, 'unrelated first') + article(2, 'second'), { watch: true, delay: true, hide: true });
  await page.waitForFunction(() => Boolean(window.releaseEvaluation));
  await page.evaluate(html => document.body.insertAdjacentHTML('beforeend', html), article(3, 'third new post'));
  await page.evaluate(() => { window.dispatchEvent(new Event('scroll')); releaseEvaluation(); });
  await page.waitForFunction(() => evaluated.length === 2);
  assert.equal(await page.locator('.quill-relevance-chip:visible').count(), 0);
  assert.equal(await page.locator('.quill-collapsed').count(), 0);
  await page.evaluate(() => releaseEvaluation());
  await page.waitForFunction(async () => (await command({ action: 'status' })).data.analysis.state === 'done');
  assert.equal(await page.locator('.quill-relevance-chip:visible').count(), 2);
  await page.evaluate(() => window.dispatchEvent(new Event('scroll')));
  await page.waitForTimeout(500);
  assert.equal(await page.evaluate(() => evaluated.length), 2);
  assert.equal(await page.evaluate(async () => (await command({ action: 'status' })).data.analysis.running), false);
  await context.close();
});
test('cancelling a rate-limited batch cancels its retry timer', async () => {
  const { page, context } = await feedFixture(article(1, 'creator demo'), { watch: true, wait: true });
  await page.waitForFunction(async () => (await command({ action: 'status' })).data.analysis.waitingUntil > 0);
  await page.evaluate(() => command({ action: 'stop-analysis' }));
  await page.waitForTimeout(1250);
  assert.equal(await page.evaluate(() => evaluated.length), 1);
  assert.equal(await page.locator('.quill-relevance-chip:visible').count(), 0);
  assert.equal(await page.evaluate(async () => (await command({ action: 'status' })).data.analysis.running), false);
  await context.close();
});
test('feed selection ignores MATCH, EXCLUDE and PRIORITY rules entirely', async () => {
  const { page, context } = await feedFixture(article(1, 'Creator clips sell products') + article(2, 'unrelated sports') + article(3, 'blocked creator demo'));
  await page.evaluate(() => command({ action: 'feed', rules: [{ kind: 'MATCH', value: 'nevermatches' }, { kind: 'EXCLUDE', value: 'blocked' }] }));
  await page.waitForFunction(() => evaluated.length === 3 && saved.length === 2);
  assert.deepEqual(await page.evaluate(() => saved.map(post => post.text)), ['Creator clips sell products', 'blocked creator demo']);
  await page.evaluate(() => window.dispatchEvent(new Event('scroll')));
  await page.waitForTimeout(400);
  assert.equal(await page.evaluate(() => evaluated.length), 3);
  assert.equal(await page.locator('.quill-match').count(), 0);
  await context.close();
});
test('failed evaluations remain visible and never fall back to keyword selection', async () => {
  const { page, context } = await feedFixture(article(1, 'outage useful AI') + article(2, 'outage unrelated'), { watch: true, hide: true });
  await page.waitForFunction(() => viewConfig.paused === true);
  const result = await page.evaluate(() => command({ action: 'feed', rules: [{ kind: 'MATCH', value: 'AI' }] }));
  assert.equal(result.ok, false); assert.match(result.error, /paused/);
  await page.evaluate(() => window.dispatchEvent(new Event('scroll')));
  await page.waitForTimeout(400);
  assert.equal(await page.evaluate(() => evaluated.length), 1);
  assert.equal(await page.locator('.quill-relevance-chip:visible').count(), 0);
  assert.equal(await page.evaluate(() => saved.length), 0);
  assert.equal(await page.locator('.quill-collapsed').count(), 0);
  await context.close();
});
test('stop cancels collection and does not save in-flight results', async () => {
  const { page, context } = await feedFixture(article(1, 'first') + article(2, 'second'), { delay: true });
  await page.evaluate(() => command({ action: 'feed' }));
  await page.waitForFunction(() => Boolean(window.releaseEvaluation));
  await page.evaluate(() => command({ action: 'stop' }));
  await page.evaluate(() => releaseEvaluation());
  await page.waitForTimeout(150);
  assert.equal(await page.evaluate(() => saved.length), 0);
  assert.equal(await page.evaluate(() => evaluated.length), 1);
  await context.close();
});
test('a large feed includes all 120 loaded posts including off-screen posts, without a silent cap', async () => {
  const { page, context } = await feedFixture(Array.from({ length: 120 }, (_, i) => article(i + 1, `AI post ${i}`)).join(''), { delay: true });
  await page.evaluate(() => command({ action: 'feed', rules: [{ kind: 'MATCH', value: 'AI' }] }));
  await page.waitForFunction(() => Boolean(window.releaseEvaluation));
  assert.equal(await page.evaluate(() => saved.length), 0);
  assert.equal(await page.locator('.quill-collapsed').count(), 0);
  const state = await page.evaluate(async () => (await command({ action: 'status' })).data);
  assert.equal(state.analysis.total, 120);
  assert.equal(state.analysis.queued, state.analysis.total - 1);
  assert.equal(state.mode, null);
  await page.evaluate(() => { delayEvaluation = false; releaseEvaluation(); });
  await page.waitForFunction(async () => (await command({ action: 'status' })).data.analysis.state === 'done');
  assert.equal(await page.evaluate(() => evaluated.length), 120);
  assert.equal(await page.evaluate(() => saved.length), 120);
  assert.equal(await page.evaluate(async () => (await command({ action: 'status' })).data.analysis.checked), 120);
  await context.close();
});
test('Analyze includes loaded posts above and below the viewport and deduplicates their URLs', async () => {
  const { page, context } = await feedFixture(Array.from({ length: 30 }, (_, i) => article(i + 1, `Loaded post ${i + 1}`)).join('') + article(1, 'Loaded post 1'));
  await page.locator('article').nth(15).scrollIntoViewIfNeeded();
  await page.evaluate(() => command({ action: 'analyze' }));
  await page.waitForFunction(async () => (await command({ action: 'status' })).data.analysis.state === 'done');
  assert.equal(await page.evaluate(() => evaluated.length), 30);
  assert.equal(await page.evaluate(() => saved.length), 0);
  assert.equal(await page.evaluate(async () => (await command({ action: 'status' })).data.analysis.total), 30);
  await context.close();
});
test('disabled Jev does not call models or silently resume keyword capture', async () => {
  const { page, context } = await feedFixture(article(1, 'AI product'), { enabled: false });
  const result = await page.evaluate(() => command({ action: 'feed', rules: [{ kind: 'MATCH', value: 'AI' }] }));
  assert.equal(result.ok, false);
  assert.equal(await page.evaluate(() => saved.length), 0);
  assert.equal(await page.evaluate(() => evaluated.length), 0);
  assert.equal(await page.locator('.quill-relevance-chip').isVisible(), false);
  await context.close();
});
test('passive chips and collapse work without collection; Show restores original DOM and Hide collapses it again', async () => {
  const { page, context } = await feedFixture(article(1, 'Creator product videos') + article(2, 'unrelated sports') + article(3, 'uncertain video only'), { watch: true, hide: true });
  await page.waitForFunction(() => evaluated.length === 3 && document.querySelectorAll('.quill-collapsed').length === 1);
  assert.equal(await page.evaluate(() => saved.length), 0);
  const low = page.locator('article').nth(1);
  await page.evaluate(() => { window.originalTweetNode = document.querySelectorAll('[data-testid="tweetText"]')[1]; originalTweetNode.addEventListener('click', () => { window.originalClicked = true; }); });
  assert.equal(await low.locator('[data-testid="tweetText"]').isVisible(), false);
  // React replaces its managed className independently of our extension state.
  await low.evaluate(node => { node.className = 'x-managed-class'; });
  assert.equal(await low.locator('[data-testid="tweetText"]').isVisible(), false);
  await low.getByRole('button', { name: 'Show original post' }).click();
  assert.equal(await low.locator('[data-testid="tweetText"]').isVisible(), true);
  await low.locator('[data-testid="tweetText"]').click();
  assert.equal(await page.evaluate(() => originalClicked && originalTweetNode === document.querySelectorAll('[data-testid="tweetText"]')[1]), true);
  await page.evaluate(() => window.dispatchEvent(new Event('scroll')));
  await page.waitForTimeout(350);
  assert.equal(await low.locator('[data-testid="tweetText"]').isVisible(), true);
  await low.getByRole('button', { name: 'Hide original post' }).click();
  assert.equal(await low.locator('[data-testid="tweetText"]').isVisible(), false);
  assert.equal(await page.locator('article').first().locator('.quill-relevance-chip').textContent(), '92%');
  assert.equal(await page.locator('article').nth(2).locator('[data-testid="tweetText"]').isVisible(), true);
  if (process.env.QUILL_FEED_SCREENSHOT) await page.screenshot({ path: process.env.QUILL_FEED_SCREENSHOT, fullPage: true });
  await page.evaluate(() => { viewConfig.watch = false; viewConfig.hideIrrelevant = false; return configChanged(); });
  assert.equal(await page.locator('.quill-collapsed').count(), 0);
  await context.close();
});
test('recycling an X article clears the old collapse but requires another click to evaluate', async () => {
  const { page, context } = await feedFixture(article(1, 'unrelated old post'), { watch: true, hide: true });
  await page.waitForFunction(() => document.querySelector('article').classList.contains('quill-collapsed'));
  await page.evaluate(() => {
    document.querySelector('article a').href = 'https://x.com/author/status/2';
    document.querySelector('[data-testid="tweetText"]').textContent = 'New creator launch';
  });
  await page.waitForFunction(() => !document.querySelector('article').classList.contains('quill-collapsed'));
  assert.equal(await page.evaluate(() => evaluated.length), 1);
  await page.evaluate(() => command({ action: 'analyze' }));
  await page.waitForFunction(() => evaluated.length === 2);
  assert.equal(await page.locator('[data-testid="tweetText"]').isVisible(), true);
  assert.match(await page.locator('.quill-relevance-chip').getAttribute('aria-label'), /Relevant/);
  await context.close();
});
test('new posts and changed interests never automatically evaluate', async () => {
  const { page, context } = await feedFixture(article(1, 'Creator workflow'), { watch: true });
  await page.waitForFunction(() => evaluated.length === 1);
  await page.evaluate(html => document.body.insertAdjacentHTML('beforeend', html), article(2, 'Another creator workflow'));
  await page.waitForTimeout(400);
  assert.equal(await page.evaluate(() => evaluated.length), 1);
  await page.evaluate(() => command({ action: 'analyze' }));
  await page.waitForFunction(() => evaluated.length === 2);
  await page.evaluate(() => { viewConfig.revision = 'brief-v2'; return configChanged(); });
  await page.waitForTimeout(400);
  assert.equal(await page.evaluate(() => evaluated.length), 2);
  await page.evaluate(() => command({ action: 'analyze' }));
  await page.waitForFunction(() => evaluated.length === 4);
  assert.equal(await page.evaluate(() => saved.length), 0);
  await context.close();
});
test('expanded controls never become an article column or squeeze the tweet at desktop/mobile widths', async () => {
  for (const width of [375, 600]) {
    const { page, context } = await feedFixture(article(1, 'Creator-led product videos for e-commerce brands. This text and its original width must be preserved.'), { watch: false });
    await page.setViewportSize({ width, height: 900 });
    await page.waitForSelector('.quill-actions');
    const before = await page.locator('.tweet-body').boundingBox();
    await page.evaluate(() => command({ action: 'analyze' }));
    await page.waitForSelector('.quill-relevance-chip:visible');
    const after = await page.locator('.tweet-body').boundingBox();
    assert.equal(after.x, before.x); assert.equal(after.width, before.width);
    assert.equal(await page.locator('article > .quill-relevance-bar').count(), 0);
    assert.equal(await page.locator('.quill-actions + .quill-relevance-bar').count(), 1);
    const bar = await page.locator('.quill-relevance-bar').boundingBox();
    assert.ok(bar.height <= 20); assert.ok(bar.width < 85);
    assert.ok(bar.x + bar.width <= width - 15, 'controls must not overflow the tweet');
    await page.getByRole('button', { name: 'Hide original post' }).click();
    assert.ok((await page.locator('article').boundingBox()).height <= 40);
    await page.getByRole('button', { name: 'Show original post' }).click();
    assert.equal((await page.locator('.tweet-body').boundingBox()).width, before.width);
    await context.close();
  }
});
test('manual Retry resumes a paused feed without per-post unavailable labels', async () => {
  const { page, context } = await feedFixture(article(1, 'outage first post'), { watch: true });
  await page.waitForFunction(() => document.querySelector('.quill-relevance-bar').dataset.state === 'error');
  await page.evaluate(() => { viewConfig.paused = true; return configChanged(); });
  await page.evaluate(html => document.body.insertAdjacentHTML('beforeend', html), article(2, 'Creator demo'));
  await page.waitForTimeout(400);
  assert.equal(await page.evaluate(() => evaluated.length), 1);
  await page.evaluate(() => { document.querySelector('article').remove(); viewConfig.paused = false; return configChanged(); });
  await page.waitForTimeout(350);
  assert.equal(await page.evaluate(() => evaluated.length), 1, 'connection recovery must not restart analysis');
  await page.evaluate(() => command({ action: 'analyze' }));
  await page.waitForSelector('.quill-relevance-chip:visible');
  assert.equal(await page.evaluate(() => evaluated.length), 2);
  assert.equal(await page.locator('.quill-relevance-chip').textContent(), '92%');
  await context.close();
});
test('turning Jev off during an in-flight check cannot collapse posts later', async () => {
  const { page, context } = await feedFixture(article(1, 'unrelated delayed post'), { watch: true, hide: true, delay: true });
  await page.waitForFunction(() => Boolean(window.releaseEvaluation));
  assert.equal(await page.locator('[data-testid="tweetText"]').isVisible(), true);
  await page.evaluate(() => { viewConfig.enabled = false; return configChanged(); });
  await page.evaluate(() => releaseEvaluation());
  await page.waitForTimeout(150);
  assert.equal(await page.locator('.quill-collapsed').count(), 0);
  assert.equal(await page.locator('.quill-relevance-chip').isVisible(), false);
  await context.close();
});
test('panel renders settings, ranks safely, and displays the sorted saved queue', async () => {
  const html = fs.readFileSync(path.join(root, 'sidebar.html'), 'utf8').replace(/<script[^>]*><\/script>/g, '').replace(/<link[^>]*>/g, '');
  const { page, context } = await pageFor(html), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.evaluate(() => {
    const config = { enabled: true, feed: true, brief: 'AI products', dailyLimit: 200, usedToday: 0, keyConfigured: true };
    window.posts = [1, 2].map(id => ({ type: 'POST', url: `https://x.com/author/status/${id}`, text: `Saved post ${id}`, reply: `Existing draft ${id}` }));
    window.storageListeners = [];
    window.chrome = { tabs: { query: async () => [], create: async () => {} }, storage: { onChanged: { addListener(fn) { storageListeners.push(fn); } }, session: { get: async () => ({}) } }, runtime: { sendMessage: async message => {
      if (message.type === 'QUILL_JEV_CONFIG') return { ok: true, data: config };
      if (message.type === 'QUILL_JEV_TEST') return { ok: true, data: { state: 'ready', message: 'Connected · Jev evaluated successfully.' } };
      if (message.type === 'QUILL_CONFIG') return { ok: true, data: { model: 'gemini-3.8-flash', keyConfigured: true, voice: { mode: 'bundled' } } };
      if (message.type === 'QUILL_LIST_CANDIDATES') return { ok: true, data: { items: posts, revision: JSON.stringify(posts) } };
      if (message.type === 'QUILL_GET_RULES') return { ok: true, data: { rules: [] } };
      if (message.type === 'QUILL_RECOVER_CANDIDATES') return { ok: true, data: { saved: 0, failures: [] } };
      if (message.type === 'QUILL_JEV_RANK') { const item = posts.find(item => item.url === message.url); item.jev = { label: 'Strong opportunity', rank: item.url.endsWith('/2') ? 90 : 70, relevant: .9, opportunity: .8, missingContext: .1 }; return { ok: true, data: item.jev }; }
      if (message.type === 'QUILL_JEV_SAVE') { Object.assign(config, message.settings); return { ok: true, data: config }; }
      if (message.type === 'QUILL_JEV_SET_VIEW') { config.feed = message.settings.watch; config.hideIrrelevant = message.settings.hideIrrelevant; return { ok: true, data: config }; }
      return { ok: false, error: 'Unexpected test message: ' + message.type };
    } } };
    window.scrollTo = () => {};
  });
  for (const file of ['defaults.js', 'sidebar.js', 'jev-panel.js']) await page.addScriptTag({ path: path.join(root, file) });
  await page.addStyleTag({ path: path.join(root, 'sidebar.css') });
  await page.evaluate(() => document.dispatchEvent(new Event('DOMContentLoaded')));
  await page.locator('#tab-settings').click();
  await page.waitForFunction(() => document.getElementById('jevBrief').value === 'AI products');
  assert.equal(await page.locator('#jevEnabled').isChecked(), true);
  await page.locator('#jevBrief').fill('Developer tools');
  await page.evaluate(() => storageListeners.forEach(fn => fn({ jevHealthV1: { newValue: { state: 'paused', message: 'Gateway rejected the evaluation request. (HTTP 400)' } } }, 'local')));
  assert.equal(await page.locator('#jevBrief').inputValue(), 'Developer tools');
  assert.match(await page.locator('#jevHealthSettings').textContent(), /HTTP 400/);
  await page.locator('#jevRetrySettings').click();
  await page.waitForFunction(() => document.getElementById('jevHealthSettings').textContent.includes('Connected'));
  await page.locator('#saveJev').click();
  await page.waitForFunction(() => document.getElementById('jevStatus').textContent.includes('Saved and applied'));
  await page.locator('#tab-capture').click();
  await page.locator('#jevHideView').check();
  await page.waitForFunction(() => document.getElementById('jevViewStatus').textContent.includes('Applied'));
  assert.equal(await page.locator('#jevAnalyze').textContent(), 'Analyze loaded posts');
  await page.locator('#tab-replies').click();
  await page.locator('#rankJev').click();
  await page.waitForFunction(() => document.getElementById('jevQueueStatus').textContent.startsWith('2 evaluated'));
  assert.equal(await page.locator('.item').first().getAttribute('data-url'), 'https://x.com/author/status/2');
  assert.equal(await page.locator('.item textarea').first().inputValue(), 'Existing draft 2');
  assert.equal(await page.locator('.jev-assessment').count(), 2);
  assert.deepEqual(errors, []);
  if (process.env.QUILL_SCREENSHOT) await page.screenshot({ path: process.env.QUILL_SCREENSHOT, fullPage: true });
  await context.close();
});
