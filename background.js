importScripts('defaults.js', 'candidates.js', 'reply-quality.js', 'gemini.js', 'jev.js');
const storageReady = chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }).then(async () => {
  const saved = await chrome.storage.local.get(['geminiModel', 'modelDefaultRevision']);
  if (saved.modelDefaultRevision === '3.8') return;
  const update = { modelDefaultRevision: '3.8' };
  if (!saved.geminiModel || saved.geminiModel === 'gemini-2.5-flash') update.geminiModel = DEFAULT_GEMINI_MODEL;
  await chrome.storage.local.set(update);
});
storageReady.catch(() => {});
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return;
  const trusted = (sender.id === chrome.runtime.id) && (sender.url === chrome.runtime.getURL('sidebar.html'));
  const restricted = ['QUILL_JEV_HEALTH','QUILL_JEV_TEST','QUILL_JEV_SET_VIEW','QUILL_JEV_CONFIG','QUILL_JEV_SAVE','QUILL_JEV_CLEAR_KEY','QUILL_JEV_RANK','QUILL_OPEN_PASTE','QUILL_CLEAR_CANDIDATES','QUILL_CONFIG','QUILL_SAVE_CONFIG','QUILL_IMPORT_VOICE','QUILL_RESET_VOICE','QUILL_CLEAR_KEY','QUILL_GENERATE_CANDIDATE'];
  if (restricted.includes(message.type) && !trusted) { sendResponse({ ok: false, error: 'This action is available only in the Quill side panel.' }); return; }
  let operation;
  if (message.type === 'QUILL_OPEN_PASTE') operation = openAndPaste(message.url);
  else if (message.type === 'QUILL_CONFIG') operation = browserConfig();
  else if (message.type === 'QUILL_SAVE_CONFIG') operation = saveBrowserConfig(message.settings);
  else if (message.type === 'QUILL_IMPORT_VOICE') operation = importVoice(message.voice);
  else if (message.type === 'QUILL_RESET_VOICE') operation = storageReady.then(() => chrome.storage.local.remove('voiceOverrides')).then(browserConfig);
  else if (message.type === 'QUILL_CLEAR_KEY') operation = storageReady.then(() => chrome.storage.local.remove('geminiApiKey')).then(browserConfig);
  else if (message.type === 'QUILL_SAVE_CANDIDATES') operation = saveCandidates(message.items);
  else if (message.type === 'QUILL_LIST_CANDIDATES') operation = trusted ? listCandidates().then(listWithJev) : listCandidates();
  else if (message.type === 'QUILL_JEV_CONFIG') operation = jevConfig();
  else if (message.type === 'QUILL_JEV_HEALTH') operation = jevHealth();
  else if (message.type === 'QUILL_JEV_TEST') operation = testJevConnection();
  else if (message.type === 'QUILL_JEV_SAVE') operation = saveJevSettings(message.settings).then(broadcastJevConfig);
  else if (message.type === 'QUILL_JEV_SET_VIEW') operation = setJevView(message.settings).then(broadcastJevConfig);
  else if (message.type === 'QUILL_JEV_CLEAR_KEY') operation = clearJevKey().then(broadcastJevConfig);
  else if (message.type === 'QUILL_JEV_RANK') operation = evaluateSavedJev(message.url);
  else if (message.type === 'QUILL_JEV_FEED' || message.type === 'QUILL_JEV_VIEW_CONFIG') {
    let allowed = false;
    try { const url = new URL(sender.url); allowed = Boolean(sender.tab?.id) && (sender.frameId === 0) && url.protocol === 'https:' && ['x.com', 'twitter.com'].includes(url.hostname); } catch {}
    if (!allowed) { sendResponse({ ok: false, error: 'Semantic capture is available only on X.' }); return; }
    operation = message.type === 'QUILL_JEV_VIEW_CONFIG' ? jevViewConfig() : evaluateJev(message.source, message.collect !== true);
  }
  else if (message.type === 'QUILL_EDIT_CANDIDATE') operation = editCandidate(message.url, message.text);
  else if (message.type === 'QUILL_CLEAR_CANDIDATES') operation = clearCandidates();
  else if (message.type === 'QUILL_REMOVE_CANDIDATE') operation = removeCandidate(message.url);
  else if (message.type === 'QUILL_GENERATE_CANDIDATE') operation = generateCandidate(message.url);
  else if (message.type === 'QUILL_RECOVER_CANDIDATES') operation = recoverLegacyCandidates();
  else if (message.type === 'QUILL_DRAFT_INLINE') {
    let allowed = false;
    try { const url = new URL(sender.url); allowed = Boolean(sender.tab?.id) && (!sender.frameId || sender.frameId === 0) && url.protocol === 'https:' && ['x.com','twitter.com'].includes(url.hostname); } catch {}
    if (!allowed) { sendResponse({ ok: false, error: 'Open an X post and click its Reply chip.' }); return; }
    operation = requestReply(message.source);
  }
  else if (message.type === 'QUILL_GET_RULES') operation = getRules();
  else if (message.type === 'QUILL_FETCH_ARTICLE') operation = fetchArticle(message.url);
  else return;
  operation.then(data => sendResponse({ ok: true, data }), error => sendResponse({ ok: false, error: !trusted && error.code === 'jev_paused' ? 'Jev is paused. Open Quill’s connection status and Retry.' : error.message, code: error.code, retryAt: error.retryAt }));
  return true;
});
async function getRules() {
  const saved = await chrome.storage.local.get(['rules', 'match', 'exclude', 'keywords']);
  if (Array.isArray(saved.rules)) return { rules: saved.rules };
  // Preserve v0.3 text settings, including an explicitly empty match list.
  const legacy = saved.keywords || saved;
  if (typeof legacy.match === 'string' || typeof legacy.exclude === 'string') {
    const rules = ['MATCH', 'EXCLUDE'].flatMap(kind => (legacy[kind.toLowerCase()] || '').split(',').map(value => value.trim()).filter(Boolean).map((value, i) => ({ id: `${kind}-${i}`, kind, value, enabled: true })));
    await chrome.storage.local.set({ rules });
    return { rules };
  }
  const rules = globalThis.QUILL_DEFAULT_RULES;
  await chrome.storage.local.set({ rules });
  return { rules };
}
async function fetchArticle(url) {
  if (!isXArticleUrl(url) && !/^https:\/\/(x|twitter)\.com\/[^/]+\/status\/\d+$/.test(url)) throw new Error('Invalid X article URL.');
  let tabId;
  try {
    const tab = await chrome.tabs.create({ url, active: false });
    tabId = tab.id;
    if (!tabId) throw new Error("Could not open article");
    await waitForTabComplete(tabId);
    let extracted, previousText = '', stableReads = 0, followed = false;
    for (let attempt = 0; attempt < 20; attempt++) {
      await wait(1000);
      extracted = await extractArticleFromTab(tabId);
      const followUrl = (extracted?.articleUrls || []).find(candidate => isXArticleUrl(candidate));
      if (!isXArticleUrl(url) && followUrl && !followed) {
        followed = true;
        await chrome.tabs.update(tabId, { url: followUrl });
        await waitForTabComplete(tabId);
        continue;
      }
      const text = extracted?.item?.text;
      if (text && text === previousText) stableReads++; else stableReads = 0;
      previousText = text || '';
      if (text && stableReads >= 2) break;
    }
    if (!extracted?.item) throw new Error('Article body unavailable. Login, access restrictions, or loading may prevent capture.');
    extracted.item.raw ||= {};
    extracted.item.raw.statusUrl = url;
    extracted.item.raw.completeness = 'available reader text only; hidden or unloaded content may be missing';
    return extracted;
  } finally {
    if (tabId) await chrome.tabs.remove(tabId).catch(() => {});
  }
}

async function extractArticleFromTab(tabId) {
  try {
    return await chrome.tabs.sendMessage(tabId, { type: "QUILL_EXTRACT_ARTICLE" });
  } catch {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["relevance.js", "content.js"] });
    return chrome.tabs.sendMessage(tabId, { type: "QUILL_EXTRACT_ARTICLE" });
  }
}

function isXArticleUrl(value) {
  try {
    const url = new URL(value);
    return ['x.com', 'twitter.com'].includes(url.hostname)
      && (/^\/i\/article\/\d+/.test(url.pathname) || /^\/[^/]+\/articles\/\d+/.test(url.pathname) || /^\/[^/]+\/article\/\d+/.test(url.pathname));
  } catch { return false; }
}

function waitForTabComplete(tabId, timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      callback(value);
    };
    const timeout = setTimeout(() => finish(reject, new Error("Article page took too long to load")), timeoutMs);
    const onUpdated = (updatedTabId, info) => {
      if (updatedTabId === tabId && info.status === "complete") finish(resolve);
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.get(tabId).then((tab) => {
      if (tab.status === "complete") finish(resolve);
    }).catch(() => finish(reject, new Error("Article tab closed")));
  });
}

function wait(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function openAndPaste(url) {
  const { items } = await listCandidates();
  const source = items.find(item => item.url === url);
  if (!source?.reply?.trim()) throw Error('Generate or write a reply first.');
  candidateUrl(source);
  const tab = await chrome.tabs.create({ url: source.url, active: true });
  await waitForTabComplete(tab.id);
  for (let attempt = 0; attempt < 30; attempt++) {
    let result;
    try { result = await chrome.tabs.sendMessage(tab.id, { type: 'QUILL_PASTE_SAVED', source, text: source.reply }); }
    catch { await wait(500); continue; }
    if (result?.ok) return { pasted: true };
    if (!result?.retry) throw Error(result?.error || 'X could not accept the draft.');
    await wait(500);
  }
  throw Error('The post did not load. Check the opened X tab and try again.');
}
