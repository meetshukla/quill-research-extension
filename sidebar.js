const itemFeedback = new Map();
let itemOperations = 0, stopBatch = false;
const $ = id => document.getElementById(id);
let captureState = { mode: null, scanning: false };
let rules = [], currentTab = 'capture', queue = [], queueRevision = -1, polling = false, preparing = false;
const status = (id, text) => { $(id).textContent = text || ''; };
const errorText = error => ({ gemini_key_required: 'Add the Gemini key to the backend before generating replies.', unauthorized: 'The companion token is not valid.', wait_before_next_reply: 'Wait a few seconds before generating another reply.' }[error.message] || error.message);
async function background(type, extra = {}) { const result = await chrome.runtime.sendMessage({ type, ...extra }); if (!result?.ok) throw Object.assign(Error(result?.error || 'Could not reach Quill.'), { code: result?.code, retryAt: result?.retryAt }); return result.data; }
async function activeXTab() { const [tab] = await chrome.tabs.query({ active: true, currentWindow: true }); if (!tab?.id || !/^https:\/\/(x|twitter)\.com\//.test(tab.url || '')) throw Error('Open an X page first.'); return tab; }
async function command(action, extra = {}, tabId) {
  const id = tabId ?? (await activeXTab()).id;
  const message = { type: 'QUILL_COMMAND', action, ...extra };
  let response;
  try { response = await chrome.tabs.sendMessage(id, message); }
  catch {
    await chrome.scripting.executeScript({ target: { tabId: id }, files: ['relevance.js', 'content.js'] });
    await chrome.scripting.insertCSS({ target: { tabId: id }, files: ['content.css'] });
    response = await chrome.tabs.sendMessage(id, message);
  }
  if (!response?.ok) throw Error(response?.error || 'Reload the X tab, then try again.');
  return response.data;
}
function activateTab(name, focus = false) {
  currentTab = name;
  window.scrollTo(0, 0);
  document.querySelectorAll('[role=tab]').forEach(tab => { const active = tab.dataset.tab === name; tab.setAttribute('aria-selected', String(active)); tab.tabIndex = active ? 0 : -1; if (active && focus) tab.focus(); });
  document.querySelectorAll('.panel').forEach(panel => { panel.hidden = panel.id !== `panel-${name}`; });
  if (name === 'replies') void refresh(true);
}
async function run(button, statusId, operation) {
  const itemOperation = Boolean(button.closest('.item')); if (itemOperation) itemOperations++;
  const wasDisabled = button.disabled; button.disabled = true;
  try { await operation(); } catch (error) { status(statusId, errorText(error)); }
  finally { if (itemOperation) itemOperations--; button.disabled = wasDisabled; if (button.id === 'collectionAction') syncCaptureControls(); }
}
async function captureAction(action, target, button) {
  await run(button, target, async () => {
    if (captureState.legacy) throw Error('This X tab uses the older extension. Its available posts are saved in Replies. Save any profile or article export before you reload X.');
    const jev = await background('QUILL_JEV_CONFIG');
    if (['feed', 'visible'].includes(action) && captureState.version !== '0.6.13') throw Error('Reload this X tab to activate click-to-start Jev. Save any temporary profile/article export first. Saved Replies are already persistent.');
    if (['feed', 'visible'].includes(action) && !jev.enabled) throw Error('Enable Jev in Settings first. Feed capture no longer uses keywords.');
    const data = await command(action);
    status(target, data.message || 'Done.'); await refresh(true);
  });
}
function syncCaptureControls() {
  const { mode, scanning, semanticBusy } = captureState;
  const analysis = captureState.analysis || {};
  $('jevAnalyze').textContent = analysis.running ? 'Cancel batch' : 'Analyze loaded posts';
  const wait = Math.max(0, Math.ceil(((analysis.waitingUntil || 0) - Date.now()) / 1000));
  $('jevAnalysisProgress').textContent = analysis.running ? `${analysis.checked || 0} / ${analysis.total || 0} checked${wait ? ` · waiting ${wait}s` : ''} · fixed batch` : analysis.state === 'done' ? `Done · ${analysis.checked || 0} / ${analysis.total || 0} checked` : analysis.state === 'cancelled' ? 'Cancelled · no more requests' : analysis.state === 'failed' ? 'Batch stopped · check connection' : 'Idle · click to analyze, then done';
  if (mode) $('captureMode').value = mode;
  if (scanning) $('captureMode').value = 'articles';
  $('captureMode').disabled = Boolean(mode || scanning || semanticBusy);
  $('collectionAction').disabled = Boolean(scanning);
  $('collectionAction').textContent = scanning ? 'Scanning articles…' : mode === 'feed' || semanticBusy ? 'Cancel batch' : mode ? 'Stop and download' : $('captureMode').value === 'articles' ? 'Scan loaded articles' : $('captureMode').value === 'feed' ? 'Analyze & save loaded posts' : 'Start collecting';
  const exporting = $('captureMode').value !== 'feed';
  document.querySelectorAll('.export-only').forEach(node => { node.hidden = !exporting; });
  $('sessionNote').textContent = exporting ? 'Profile and article captures export JSON. Coverage can be partial.' : 'Reply candidates are saved locally and stay after reload.';
  $('modeHint').textContent = {
    feed: 'Collect relevant posts by meaning. No keyword rules or keyword fallback.',
    profile: 'Scroll a profile to collect all loaded posts.',
    articles: 'Scroll the Articles tab to load links, then scan.'
  }[$('captureMode').value];
}
async function refresh(force = false) {
  if (polling) return; polling = true;
  try {
    try {
      const tab = await activeXTab();
      const state = await command('status', {}, tab.id);
      $('captureCount').textContent = state.count;
      $('scanBadge').textContent = state.scanning ? 'Scanning' : state.mode || state.semanticBusy ? 'Collecting' : 'Ready';
      $('sourceContext').textContent = 'x.com' + new URL(tab.url).pathname;
      captureState = { ...state, legacy: state.apiVersion !== 2 }; syncCaptureControls();
      $('scanBadge').dataset.active = String(Boolean(state.mode || state.semanticBusy || state.scanning));
      if (state.apiVersion !== 2) status('scanStatus', 'An older X session is open. Its available posts have been recovered. Reload X only after saving any profile or article capture.');
      else if (state.mode || state.semanticBusy || state.scanning || state.articleProgress?.total || state.failures?.length) status('scanStatus', state.message);
    } catch (error) {
      $('sourceContext').textContent = errorText(error); $('scanBadge').textContent = 'Open X';
      captureState = { mode: null, scanning: false }; syncCaptureControls();
      $('scanBadge').dataset.active = 'false';
    }
    const data = await background('QUILL_LIST_CANDIDATES');
    if ($('captureMode').value === 'feed') $('captureCount').textContent = data.items.length;
    const editing = document.activeElement?.matches('#items textarea');
    if (!editing && (force || (!itemOperations && data.revision !== queueRevision))) { queue = data.items; queueRevision = data.revision; renderQueue(); }
  } catch (error) { status('queueStatus', errorText(error)); }
  finally { polling = false; }
}
function renderQueue() {
  const posts = queue.filter(item => item.type === 'POST');
  $('replyCount').textContent = posts.length; $('replyCount').hidden = posts.length === 0;
  $('queueTotal').textContent = posts.length;
  $('items').replaceChildren();
  if (!posts.length) {
    const empty = document.createElement('div'); empty.className = 'empty-state';
    empty.innerHTML = '<h2>No saved candidates</h2><p>Scroll your feed with collection on, or use + List on a post.</p>';
    $('items').append(empty); return;
  }
  if ($('jevSort').value === 'jev') posts.sort((a, b) => (b.jev?.rank ?? -1) - (a.jev?.rank ?? -1));
  for (const item of posts) {
    const node = document.createElement('article'); node.className = 'item'; node.dataset.url = item.url;
    const head = document.createElement('div'); head.className = 'item-head';
    const source = document.createElement('a'); source.className = 'source-link'; source.href = item.url; source.target = '_blank'; source.rel = 'noopener'; source.textContent = item.sourceHandle ? `@${item.sourceHandle}` : 'Open source';
    const date = document.createElement('span'); date.className = 'item-date'; date.textContent = item.publishedAt && Number.isFinite(Date.parse(item.publishedAt)) ? new Date(item.publishedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : 'Date unavailable';
    head.append(source, date);
    const text = document.createElement('div'); text.className = 'item-text'; text.textContent = item.text;
    const meta = document.createElement('div'); meta.className = 'item-meta';
    const media = document.createElement('span'); media.textContent = `${item.raw?.media?.length || 0} media links`;
    meta.append(media);
    if (item.jev) {
      const assessment = document.createElement('span'); assessment.className = 'jev-assessment';
      assessment.textContent = `Jev · ${item.jev.label} · ${item.jev.rank}/100`;
      assessment.title = `Model estimates: relevance ${Math.round(item.jev.relevant * 100)}%, reply opportunity ${Math.round(item.jev.opportunity * 100)}%, missing context ${Math.round(item.jev.missingContext * 100)}%. Topic relevance alone determines sorting; reply opportunity does not filter posts. Not a fact check.`;
      meta.append(assessment);
    }
    const draft = document.createElement('textarea'); draft.setAttribute('aria-label', `Edit reply to ${item.sourceHandle || 'source post'}`); draft.value = item.reply || ''; draft.placeholder = 'Write or generate a reply…';
    const itemStatus = document.createElement('p'); itemStatus.className = 'status item-status'; itemStatus.setAttribute('role', 'status'); itemStatus.textContent = itemFeedback.get(item.url) || '';
    const feedback = text => { itemFeedback.set(item.url, text); itemStatus.textContent = text; const current = [...document.querySelectorAll('.item')].find(node => node.dataset.url === item.url); if (current) current.querySelector('.item-status').textContent = text; };
    let pendingEdit = Promise.resolve();
    draft.oninput = () => { item.reply = draft.value; const value = draft.value; pendingEdit = background('QUILL_EDIT_CANDIDATE', { url: item.url, text: value }); pendingEdit.catch(error => { feedback(errorText(error)); }); };
    const actions = document.createElement('div'); actions.className = 'item-actions';
    const generate = document.createElement('button'); generate.textContent = item.reply ? 'Regenerate' : 'Generate reply';
    generate.onclick = () => run(generate, 'queueStatus', async () => {
      if (preparing) throw Error('Wait for the current batch to finish.');
      await pendingEdit; feedback('Generating…');
      try { const result = await background('QUILL_GENERATE_CANDIDATE', { url: item.url }); draft.value = result.text; item.reply = result.text; generate.textContent = 'Regenerate'; feedback('Review and edit before copying.'); }
      catch (error) { feedback(errorText(error)); }
    });
    const copy = document.createElement('button'); copy.className = 'secondary'; copy.textContent = 'Copy';
    copy.onclick = () => run(copy, 'queueStatus', async () => { if (!draft.value.trim()) throw Error('Write or generate a reply first.'); await pendingEdit; await navigator.clipboard.writeText(draft.value); feedback('Copied. Paste it when you are ready.'); });
    const remove = document.createElement('button'); remove.className = 'text-button'; remove.textContent = 'Remove';
    remove.onclick = () => run(remove, 'queueStatus', async () => { await pendingEdit; await background('QUILL_REMOVE_CANDIDATE', { url: item.url }); await refresh(true); });
    const openPaste = document.createElement('button'); openPaste.className = 'secondary'; openPaste.textContent = 'Open & paste';
    openPaste.onclick = () => run(openPaste, 'queueStatus', async () => {
      await pendingEdit;
      if (!draft.value.trim()) throw Error('Generate or write a reply first.');
      feedback('Opening X…'); await background('QUILL_OPEN_PASTE', { url: item.url }); feedback('Draft filled in X. Review it and click Reply there.');
    });
    actions.append(generate, openPaste, copy, remove); node.append(head, text, meta, draft, actions, itemStatus); $('items').append(node);
  }
}
async function saveRules(message = 'Keywords saved.') {
  await chrome.storage.local.set({ rules }); status('keywordStatus', message);
  await command('rules', { rules }).catch(() => {});
}
function renderRules() {
  $('ruleCount').textContent = `${rules.filter(rule => rule.enabled !== false).length} active`;
  $('rules').replaceChildren();
  for (const [kind, description] of [['MATCH', 'Capture posts with these words.'], ['EXCLUDE', 'Skip these posts, including priority matches.'], ['PRIORITY', 'Capture and show these sources first.']]) {
    const filter = $('ruleSearch').value.trim().toLowerCase();
    const matching = rules.filter(r => r.kind === kind && r.value.toLowerCase().includes(filter));
    if (filter && !matching.length) continue;
    const section = document.createElement('section'); section.className = 'rule-group';
    const heading = document.createElement('div'); heading.className = 'rule-heading';
    const title = document.createElement('h2'); title.textContent = kind;
    const total = document.createElement('span'); total.className = 'subtle'; const entries = matching; total.textContent = entries.length;
    heading.append(title, total); const desc = document.createElement('p'); desc.className = 'rule-description'; desc.textContent = description; section.append(heading, desc); const chips = document.createElement('div'); chips.className = 'rule-chips'; section.append(chips);
    for (const rule of entries) {
      const row = document.createElement('div'); row.className = `rule-row rule ${kind.toLowerCase()}`;
      const enabled = document.createElement('input'); enabled.type = 'checkbox'; enabled.checked = rule.enabled !== false; enabled.setAttribute('aria-label', `Enable ${rule.value}`);
      enabled.onchange = async () => { rule.enabled = enabled.checked; await saveRules(); $('ruleCount').textContent = `${rules.filter(r => r.enabled !== false).length} active`; };
      const value = document.createElement('input'); value.className = 'rule-value'; value.value = rule.value; value.size = Math.max(6, Math.min(24, rule.value.length + 1)); value.maxLength = 160; value.setAttribute('aria-label', `Edit ${kind.toLowerCase()} keyword ${rule.value}`);
      value.onchange = async () => { const next = value.value.trim(); if (!next || rules.some(r => r !== rule && r.kind === kind && r.value.toLowerCase() === next.toLowerCase())) { value.value = rule.value; status('keywordStatus', 'Use a non-empty, unique keyword.'); return; } rule.value = next; await saveRules(); };
      const remove = document.createElement('button'); remove.className = 'text-button'; remove.textContent = '×'; remove.setAttribute('aria-label', `Remove ${rule.value}`); remove.onclick = async () => { rules = rules.filter(r => r !== rule); await saveRules(); renderRules(); };
      row.append(enabled, value, remove); chips.append(row);
    }
    $('rules').append(section);
  }
  if (!$('rules').children.length) {
    const empty = document.createElement('div'); empty.className = 'empty-state';
    empty.innerHTML = '<h2>No matching keywords</h2><p>Use another filter or add a keyword.</p>';
    $('rules').append(empty);
  }
}
function showConfig(data) {
  $('keyBadge').textContent = data.keyConfigured ? 'Key saved' : 'Key needed';
  $('geminiModel').value = data.model;
  $('voiceStatus').textContent = data.voice.mode === 'imported' ? 'Both imported files are ready.' : 'Both bundled files are verified.';
}
async function saveSettings() {
  const data = await background('QUILL_SAVE_CONFIG', { settings: { key: $('geminiKey').value, model: $('geminiModel').value } });
  $('geminiKey').value = ''; showConfig(data); status('connectionStatus', 'Saved in this browser. Generate a reply from the Replies tab.');
}
document.addEventListener('DOMContentLoaded', async () => {
  document.querySelectorAll('[role=tab]').forEach((tab, index, tabs) => { tab.onclick = () => activateTab(tab.dataset.tab); tab.onkeydown = event => { let next; if (event.key === 'ArrowRight') next = (index + 1) % tabs.length; else if (event.key === 'ArrowLeft') next = (index + tabs.length - 1) % tabs.length; else if (event.key === 'Home') next = 0; else if (event.key === 'End') next = tabs.length - 1; else return; event.preventDefault(); activateTab(tabs[next].dataset.tab, true); }; });
  document.querySelector('.brand').onclick = event => { event.preventDefault(); activateTab('capture'); };
  $('captureMode').onchange = () => { syncCaptureControls(); status('scanStatus', ''); };
  $('collectionAction').onclick = () => captureAction(captureState.mode || captureState.semanticBusy ? 'stop' : $('captureMode').value, 'scanStatus', $('collectionAction'));
  for (const [id, action] of [['manualScan','visible'],['captureCurrent','current'],['capturePage','page'],['download','download'],['copyJson','copy']]) $(id).onclick = () => captureAction(action, 'scanStatus', $(id));
  $('ruleSearch').oninput = renderRules;
  $('keywordForm').onsubmit = event => { event.preventDefault(); void run($('addRule'), 'keywordStatus', async () => { const value = $('ruleValue').value.trim(), kind = $('ruleKind').value; if (!value) return; if (rules.some(r => r.kind === kind && r.value.toLowerCase() === value.toLowerCase())) throw Error('This keyword is already in the list.'); rules.push({ id: crypto.randomUUID(), kind, value, enabled: true }); await saveRules(); $('ruleValue').value = ''; renderRules(); }); };
  $('restorePresets').onclick = () => run($('restorePresets'), 'keywordStatus', async () => { for (const rule of globalThis.QUILL_DEFAULT_RULES) if (!rules.some(r => r.kind === rule.kind && r.value.toLowerCase() === rule.value.toLowerCase())) rules.push({ ...rule }); await saveRules('Missing presets added. Existing edits and switches were kept.'); renderRules(); });
  $('settingsForm').onsubmit = event => { event.preventDefault(); void run($('saveSettings'), 'connectionStatus', saveSettings); };
  $('clearKey').onclick = () => run($('clearKey'), 'connectionStatus', async () => { showConfig(await background('QUILL_CLEAR_KEY')); $('geminiKey').value = ''; status('connectionStatus', 'Key removed.'); });
  $('importVoice').onclick = () => run($('importVoice'), 'connectionStatus', async () => {
    const profile = $('profileFile').files[0], opinions = $('opinionsFile').files[0];
    if (!profile || !opinions) throw Error('Select both voice files.');
    showConfig(await background('QUILL_IMPORT_VOICE', { voice: { profile: await profile.text(), opinions: await opinions.text() } }));
    status('connectionStatus', 'Both voice files saved.');
  });
  $('resetVoice').onclick = () => run($('resetVoice'), 'connectionStatus', async () => { showConfig(await background('QUILL_RESET_VOICE')); status('connectionStatus', 'Bundled voice files restored.'); });
  $('stopBatch').onclick = () => { stopBatch = true; status('queueStatus', 'Stopping after the current reply…'); };
  $('generateAll').onclick = () => run($('generateAll'), 'queueStatus', async () => {
    if (preparing) return;
    preparing = true; stopBatch = false; $('stopBatch').hidden = false;
    let completed = 0, failed = 0;
    try {
      const items = (await background('QUILL_LIST_CANDIDATES')).items.filter(item => !item.reply?.trim());
      for (const item of items) {
        if (stopBatch) break;
        const latest = (await background('QUILL_LIST_CANDIDATES')).items.find(saved => saved.url === item.url);
        if (!latest || latest.reply?.trim()) continue;
        status('queueStatus', `Generating ${completed + failed + 1} of ${items.length}… Keep this panel open.`);
        try { await background('QUILL_GENERATE_CANDIDATE', { url: item.url }); completed++; }
        catch (error) { failed++; itemFeedback.set(item.url, errorText(error)); if (/key|quota|rate limit|could not be reached/i.test(error.message)) { stopBatch = true; } }
        await refresh(true);
      }
      status('queueStatus', `${completed} replies generated. ${failed} failed.${stopBatch ? ' Batch stopped.' : ''}`);
    } finally { preparing = false; $('stopBatch').hidden = true; await refresh(true); }
  });
  $('clearReplies').onclick = () => run($('clearReplies'), 'queueStatus', async () => {
    const data = await background('QUILL_LIST_CANDIDATES');
    if (!data.items.length) { status('queueStatus', 'Replies is already empty.'); return; }
    if (!window.confirm(`Delete all ${data.items.length} saved posts and reply drafts? This cannot be undone.`)) return;
    const result = await background('QUILL_CLEAR_CANDIDATES');
    itemFeedback.clear(); await refresh(true);
    status('queueStatus', `Deleted ${result.removed} saved posts and drafts. Active collection can add new posts.`);
  });
  $('refresh').onclick = () => refresh(true);
  $('openNext').onclick = () => run($('openNext'), 'queueStatus', async () => { await refresh(true); const ready = queue.filter(item => item.type === 'POST' && item.reply).slice(0,5); if (!ready.length) throw Error('Prepare or write a reply first.'); for (const item of ready) await chrome.tabs.create({ url: item.url, active: false }); status('queueStatus', `Opened ${ready.length} source posts. Review and copy replies here.`); });
  $('recoverCandidates').onclick = () => run($('recoverCandidates'), 'queueStatus', recoverCandidates);
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.replyCandidatesV1) void refresh();
    if (area === 'session' && changes.reviewCandidateUrl) void revealCandidate(changes.reviewCandidateUrl.newValue);
  });
  try { showConfig(await background('QUILL_CONFIG')); } catch (error) { status('connectionStatus', errorText(error)); }
  try { rules = (await background('QUILL_GET_RULES')).rules; renderRules(); } catch (error) { status('keywordStatus', errorText(error)); }
  await recoverCandidates();
  const selection = await chrome.storage.session.get('reviewCandidateUrl');
  if (selection.reviewCandidateUrl) await revealCandidate(selection.reviewCandidateUrl);
  await refresh(); setInterval(() => void refresh(), 1200);
});

async function recoverCandidates() {
  try { const result = await background('QUILL_RECOVER_CANDIDATES');
    if (result.failures.length) status('queueStatus', result.failures.join(' '));
    else if (result.saved) status('queueStatus', `${result.saved} candidates recovered from open tabs.`);
    await refresh(true);
  } catch (error) { status('queueStatus', errorText(error)); }
}
async function revealCandidate(url) {
  activateTab('replies');
  // A storage event can arrive while the active-tab status poll is running.
  const data = await background('QUILL_LIST_CANDIDATES'); queue = data.items; queueRevision = data.revision; renderQueue();
  const node = [...document.querySelectorAll('.item')].find(node => node.dataset.url === url);
  if (node) { node.scrollIntoView({ block: 'nearest' }); node.querySelector('textarea').focus({ preventScroll: true }); }
}
