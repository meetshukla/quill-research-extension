// One writer prevents captures from separate tabs from overwriting each other.
let candidateWrite = Promise.resolve();
const CANDIDATE_KEY = 'replyCandidatesV1';
const MAX_CANDIDATES = 2000;
const MAX_CANDIDATE_BYTES = 8 * 1024 * 1024;
function withCandidates(operation) {
  const task = candidateWrite.catch(() => {}).then(async () => {
    const saved = await chrome.storage.local.get(CANDIDATE_KEY);
    const state = saved[CANDIDATE_KEY] || { items: [], revision: 0, recovered: {} };
    if (!Array.isArray(state.items)) throw Error('Saved reply data could not be read. It was not replaced.');
    return operation(state);
  });
  candidateWrite = task.catch(() => {});
  return task;
}
async function commitCandidates(state) {
  if (state.items.length > MAX_CANDIDATES || new TextEncoder().encode(JSON.stringify(state)).length > MAX_CANDIDATE_BYTES) throw Error('Replies storage is full. Remove saved items before collecting more. Existing items were kept.');
  state.revision++;
  try { await chrome.storage.local.set({ [CANDIDATE_KEY]: state }); }
  catch { throw Error('Replies could not be saved. Browser storage may be full. Existing items were kept.'); }
}
function candidateUrl(item) {
  if (!item || item.type !== 'POST' || typeof item.text !== 'string' || !/^https:\/\/(x|twitter)\.com\/[^/]+\/status\/\d+$/.test(item.url)) throw Error('A valid X source post is required.');
  return item.url.replace('https://twitter.com/', 'https://x.com/');
}
function mergeCandidate(previous, item) {
  const merged = { ...previous, ...item, url: candidateUrl(item), savedAt: previous?.savedAt || new Date().toISOString(), updatedAt: new Date().toISOString() };
  if (previous) {
    if (previous.text.length > item.text.length) merged.text = previous.text;
    merged.reply = previous.reply ?? item.reply;
    merged.replyRevision = previous.replyRevision || 0;
  }
  merged.raw = { ...previous?.raw, ...item.raw, media: [...new Map([...(previous?.raw?.media || []), ...(item.raw?.media || [])].map(media => [media.url, media])).values()] };
  return merged;
}
function saveCandidates(items, recovery = false) {
  return withCandidates(async state => {
    const byUrl = new Map(state.items.map(item => [item.url, item]));
    let saved = 0;
    state.recovered ||= {};
    for (const item of items) {
      const url = candidateUrl(item);
      const stamp = item.raw?.capturedAt || item.savedAt || 'legacy';
      if (recovery && state.recovered[url] === stamp) continue;
      byUrl.set(url, mergeCandidate(byUrl.get(url), item));
      if (recovery) state.recovered[url] = stamp;
      saved++;
    }
    if (saved) { state.items = [...byUrl.values()]; await commitCandidates(state); }
    return { saved, count: state.items.length };
  });
}
function listCandidates() { return withCandidates(state => ({ items: state.items, revision: state.revision })); }
function editCandidate(url, text) {
  return withCandidates(async state => {
    const item = state.items.find(item => item.url === url);
    if (!item) throw Error('This saved item was removed.');
    item.reply = String(text); item.replyRevision = (item.replyRevision || 0) + 1;
    await commitCandidates(state); return { text: item.reply };
  });
}
function removeCandidate(url) {
  return withCandidates(async state => { state.items = state.items.filter(item => item.url !== url); await commitCandidates(state); return { count: state.items.length }; });
}
function clearCandidates() {
  return withCandidates(async state => {
    const removed = state.items.length;
    state.items = [];
    // Keep recovery markers so reopening the panel cannot restore cleared imports.
    await commitCandidates(state);
    return { removed, count: 0 };
  });
}
async function generateCandidate(url) {
  const { items } = await listCandidates(); const source = items.find(item => item.url === url);
  if (!source) throw Error('This saved item was removed.');
  const expectedRevision = source.replyRevision || 0;
  const result = await requestReply({ ...source, reply: undefined });
  return withCandidates(async state => {
    const item = state.items.find(item => item.url === url);
    if (!item) throw Error('The source was removed while the reply was generating.');
    if ((item.replyRevision || 0) !== expectedRevision) throw Error('Your newer reply edit was kept.');
    item.reply = result.text; item.replyRevision = expectedRevision + 1;
    await commitCandidates(state); return { text: item.reply };
  });
}
async function recoverLegacyCandidates() {
  const tabs = await chrome.tabs.query({ url: ['https://x.com/*', 'https://twitter.com/*'] });
  let saved = 0; const failures = [];
  for (const tab of tabs) {
    try {
      // Do not inject scripts, reload pages, or alter a running old session.
      const response = await chrome.tabs.sendMessage(tab.id, { type: 'QUILL_COMMAND', action: 'list' });
      if (!response?.ok || response.data?.apiVersion === 2) continue;
      const items = (response.data?.items || []).filter(item => item.type === 'POST');
      if (items.length) saved += (await saveCandidates(items, true)).saved;
    } catch (error) {
      if (/storage|saved reply/i.test(error.message)) failures.push(error.message);
      // A tab with no old content script has no readable in-memory candidates.
    }
  }
  return { saved, failures };
}
