// Reversible, keyword-free feed view. Never replaces X's post DOM or publishes replies.
globalThis.createQuillRelevance = ({ background, extractArticle, onSaved, onStatus }) => {
  let settings = { enabled: false, watch: false, hideIrrelevant: false, revision: '' };
  // A page-session action, never a persisted preference. Reloads start idle.
  let watching = false;
  let batch = { state: 'idle', sources: [] };
  let retryTimer = null, waitingUntil = 0;
  let generation = 0, collectionEpoch = 0, active = null, draining = false, savedTail = Promise.resolve(), configRequest = 0;
  const entries = new Map(), pending = new Map(), overrides = new Map(), saved = new Set();
  const collapsedPosts = new Map(), articleSources = new WeakMap();
  // X can unload media or temporarily clear its children when height changes.
  // A collapsed post retains its decision/source until Show, a new ID, or a new brief.
  function sourceFor(article) {
    const fresh = extractArticle(article), previous = articleSources.get(article);
    if (article.dataset.quillCollapsed === 'true' && previous && (!fresh || fresh.url === previous.url)) return previous;
    if (fresh) articleSources.set(article, fresh);
    return fresh;
  }
  function cancelWait() { clearTimeout(retryTimer); retryTimer = null; waitingUntil = 0; }
  const keyOf = item => JSON.stringify([item.url, item.text, Boolean(item.raw?.media?.length), Boolean(item.raw?.articleLinks?.length), /truncated/i.test(item.raw?.completeness || '')]);
  const collecting = () => active?.epoch === collectionEpoch || [...pending.values()].some(entry => entry.epoch === collectionEpoch);
  const notice = text => onStatus(text, collecting());
  const putText = (node, text) => { if (node.textContent !== text) node.textContent = text; };
  const currentEntry = item => { const entry = entries.get(item.url); return entry?.key === keyOf(item) ? entry : null; };

  function paint(article, item) {
    let bar = article.querySelector('.quill-relevance-bar');
    if (!item) { bar?.remove(); delete article.dataset.quillCollapsed; article.classList.remove('quill-collapsed', 'quill-jev-match', 'quill-match'); return; }
    const key = keyOf(item), entry = currentEntry(item), result = settings.enabled ? (entry?.presented ? entry.result : null) || collapsedPosts.get(item.url)?.result : null;
    if (result?.label === 'Low relevance' && !collapsedPosts.has(item.url)) {
      collapsedPosts.set(item.url, { source: item, result });
      if (collapsedPosts.size > 1500) collapsedPosts.delete(collapsedPosts.keys().next().value);
    }
    if (!bar) {
      bar = document.createElement('div'); bar.className = 'quill-relevance-bar';
      const chip = document.createElement('span'); chip.className = 'quill-relevance-chip';
      const toggle = document.createElement('button'); toggle.className = 'quill-visibility-toggle'; toggle.type = 'button';
      toggle.onclick = event => {
        event.preventDefault(); event.stopPropagation();
        const source = sourceFor(article);
        if (!source || source.url !== bar.dataset.url) { paint(article, source); return; }
        overrides.set(source.url, article.dataset.quillCollapsed !== 'true');
        if (overrides.size > 1000) overrides.delete(overrides.keys().next().value);
        paint(article, source);
      };
      bar.append(chip, toggle);
    }
    bar.dataset.key = key;
    bar.dataset.url = item.url;
    const collapsed = overrides.has(item.url) ? overrides.get(item.url) : Boolean(settings.enabled && settings.hideIrrelevant && result?.label === 'Low relevance');
    article.classList.toggle('quill-collapsed', collapsed);
    // X owns className and can overwrite it during hover/live-count updates.
    // Keep collapse styling and click intent on our own attribute instead.
    if (article.dataset.quillCollapsed !== String(collapsed)) article.dataset.quillCollapsed = String(collapsed);
    article.classList.remove('quill-match', 'quill-jev-match');
    // X's article root is a horizontal flex row. Only a collapsed placeholder
    // belongs there; expanded controls live in the existing tweet action row.
    if (collapsed) {
      if (bar.parentElement !== article) article.append(bar);
    } else {
      const reply = article.querySelector('[data-testid="reply"]');
      const actionRow = reply?.closest('[role="group"]') || article.querySelector('[role="group"]');
      if (!actionRow) { bar.remove(); return; }
      const quillActions = actionRow.querySelector('.quill-actions');
      if (quillActions) { if (quillActions.nextElementSibling !== bar) quillActions.after(bar); }
      else if (bar.parentElement !== actionRow) actionRow.append(bar);
    }
    const chip = bar.querySelector('.quill-relevance-chip'), toggle = bar.querySelector('button');
    const label = result ? `${Math.round(result.relevant * 100)}%${result.missingContext >= .35 ? ' ?' : ''}` : '';
    putText(chip, collapsed ? `Hidden${result ? ' · ' + result.label.toLowerCase() : ''}` : label);
    chip.dataset.level = result?.label || 'Unrated';
    chip.hidden = !collapsed && !result;
    bar.dataset.state = entry?.state || 'idle';
    chip.title = result ? `${result.missingContext >= .35 ? 'Context missing — review the original post. ' : ''}Topic relevance estimate for your creative/marketing interests: ${Math.round(result.relevant * 100)}%. Reply opportunity: ${Math.round(result.opportunity * 100)}%. These are model estimates, not verified facts. Jev has not viewed the media.` : '';
    chip.setAttribute('aria-label', result ? `Jev: ${result.label}, ${label} topic relevance${result.missingContext >= .35 ? ', context missing' : ''}` : entry?.error ? `Jev unavailable: ${entry.error}` : settings.enabled ? 'Jev: not rated yet' : 'Jev is off');
    putText(toggle, collapsed ? 'Show' : 'Hide');
    toggle.setAttribute('aria-expanded', String(!collapsed));
    toggle.setAttribute('aria-label', `${collapsed ? 'Show' : 'Hide'} original post by ${item.sourceHandle || 'this author'}`);
    bar.title = collapsed ? 'Post collapsed locally by Quill. Show restores the original post.' : '';
  }
  function paintAll() { for (const article of document.querySelectorAll('article')) paint(article, sourceFor(article)); }
  function saveSelected(entry) {
    if (entry.epoch !== collectionEpoch || !entry.result?.selected) return;
    const stamp = `${collectionEpoch}:${entry.key}`;
    if (saved.has(stamp)) return;
    saved.add(stamp);
    const epoch = collectionEpoch;
    savedTail = savedTail.catch(() => {}).then(async () => {
      if (epoch !== collectionEpoch || entry.generation !== generation) return;
      try { await background('QUILL_SAVE_CANDIDATES', { items: [entry.source] }); onSaved(entry.source); }
      catch (error) { saved.delete(stamp); notice(error.message); }
    });
  }
  function queue(item, collect = false) {
    if (settings.paused) return;
    let entry = currentEntry(item);
    if (entry) {
      if (collect) entry.epoch = collectionEpoch;
      if (entry.result) { if (collect) saveSelected(entry); return; }
      if (entry.state === 'checking' || entry.state === 'queued' || entry.retryAt > Date.now()) return;
    }
    entry = { source: item, key: keyOf(item), epoch: collect ? collectionEpoch : -1, generation, state: 'queued' };
    entries.set(item.url, entry); pending.set(item.url, entry);
    if (entries.size > 1500) {
      const removable = [...entries.keys()].find(url => !pending.has(url) && active?.source.url !== url);
      if (removable) entries.delete(removable);
    }
  }
  async function drain() {
    if (draining || retryTimer) return;
    draining = true;
    try {
      while (pending.size) {
        if (Date.now() >= batch.expiresAt) { pending.clear(); batch.state = 'failed'; notice('No progress for five minutes. Click Analyze loaded posts to try again.'); break; }
        const [url, entry] = pending.entries().next().value; pending.delete(url);
        if (entry.generation !== generation || settings.paused || !settings.enabled || !watching) { entry.state = 'idle'; continue; }
        active = entry; entry.state = 'checking'; paintAll();
        try {
          const result = await background('QUILL_JEV_FEED', { source: entry.source, collect: entry.epoch === collectionEpoch });
          if (entry.generation !== generation || entries.get(url) !== entry || !settings.enabled) continue;
          entry.result = result; entry.state = 'done'; saveSelected(entry);
          batch.expiresAt = Date.now() + 300000;
        } catch (error) {
          if (entry.generation !== generation) continue;
          if (error.code === 'jev_wait') {
            entry.state = 'waiting';
            waitingUntil = Math.min(batch.expiresAt, Math.max(Date.now() + 250, error.retryAt || Date.now() + 2500));
            entry.retryAt = waitingUntil; pending.set(url, entry);
            retryTimer = setTimeout(() => { retryTimer = null; waitingUntil = 0; void drain(); }, waitingUntil - Date.now());
            break;
          }
          entry.error = error.message; entry.state = 'error'; entry.retryAt = Date.now() + 60000;
          if (error.code === 'jev_paused') { settings.paused = true; pending.clear(); }
          notice(`${error.message} Unrated posts stay visible; no keyword fallback.`);
        } finally { active = null; paintAll(); }
      }
    } finally {
      draining = false;
      if (watching && !pending.size && !retryTimer) {
        const finishedGeneration = generation;
        await savedTail;
        if (generation === finishedGeneration && watching) {
          for (const source of batch.sources) { const entry = currentEntry(source); if (entry?.result) entry.presented = true; }
          watching = false; batch.state = settings.paused || batch.state === 'failed' ? 'failed' : 'done';
          paintAll();
        }
      }
    }
  }
  function refresh() {
    // Rendering is deliberately pure: DOM mutations/scroll/Hide never enqueue work.
    paintAll();
  }
  async function configure() {
    const request = ++configRequest;
    const next = await background('QUILL_JEV_VIEW_CONFIG');
    if (request !== configRequest) return;
    const invalidated = next.revision !== settings.revision || next.enabled !== settings.enabled;
    if (invalidated || Boolean(next.paused) !== Boolean(settings.paused)) {
      generation++; pending.clear(); cancelWait();
      watching = false; batch = { state: 'idle', sources: [] };
      for (const [url, entry] of entries) {
        if (invalidated || !entry.result) entries.delete(url);
        else entry.generation = generation;
      }
    }
    if (invalidated || next.hideIrrelevant !== settings.hideIrrelevant) overrides.clear();
    if (invalidated) collapsedPosts.clear();
    if (!next.enabled || next.paused) watching = false;
    settings = next; refresh();
  }
  async function startAnalyzing() {
    if (watching) throw Error('A batch is already running. Cancel it before starting another.');
    await configure();
    if (!settings.enabled) throw Error('Enable Jev with your Gateway key in Settings first.');
    if (settings.paused) throw Error('Jev is paused. Check the connection status below before starting.');
    beginBatch(loadedSources());
  }
  function loadedSources() {
    // Include off-screen posts already mounted by X. Never scroll or fetch more.
    return [...document.querySelectorAll('article')].map(sourceFor).filter(Boolean);
  }
  function beginBatch(sources, collect = false) {
    if (watching) throw Error('A batch is already running. Cancel it before starting another.');
    const snapshot = [...new Map(sources.map(source => [source.url, structuredClone(source)])).values()];
    batch = { state: 'running', sources: snapshot, expiresAt: Date.now() + 300000 }; watching = true;
    for (const source of snapshot) queue(source, collect);
    void drain();
  }
  async function stopAnalyzing() {
    watching = false;
    await stopCollection();
    paintAll();
  }
  function analysisStatus() {
    return { running: watching, state: batch.state, total: batch.sources.length, checked: batch.sources.filter(source => currentEntry(source)?.result).length, queued: pending.size, waitingUntil, checking: Boolean(active && active.generation === generation) };
  }
  async function collect(sources) {
    if (!settings.enabled) throw Error('Enable Jev with your Gateway key first. Feed capture no longer uses keywords.');
    if (settings.paused) throw Error('Jev is paused. Open Quill’s connection status and Retry.');
    beginBatch(sources, true);
  }
  async function stopCollection() {
    watching = false; if (batch.state === 'running') batch.state = 'cancelled';
    collectionEpoch++; saved.clear();
    generation++; pending.clear(); cancelWait();
    for (const [url, entry] of entries) { if (!entry.presented) entries.delete(url); else entry.generation = generation; }
    await savedTail;
  }
  return { configure, refresh, collect, loadedSources, stopCollection, collecting, startAnalyzing, stopAnalyzing, analysisStatus };
};
