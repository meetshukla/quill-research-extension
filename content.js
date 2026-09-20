(() => {
  if (window.__quillResearchLoaded) return;
  window.__quillResearchLoaded = true;
  const items = new Map(), failures = [], discoveredArticles = new Set(), collected = new Set();
  let mode = null, scanning = false, timer, rules = [], revision = 0, inspected = 0, lastMode = 'feed';
  let sourceUrl = location.href, articleSource = '', articleProgress = { checked: 0, total: 0 }, captureTail = Promise.resolve();
  const panel = document.createElement('aside'); panel.id = 'quill-collector-panel'; panel.hidden = true;
  panel.innerHTML = '<div class="quill-collector-head"><span class="quill-collector-dot"></span><strong id="quill-collector-title">Quill collector</strong></div><div class="quill-collector-row"><span>Collected</span><strong id="quill-collector-count">0</strong></div><p id="quill-collector-detail" role="status"></p><p class="quill-collector-note"></p>';
  document.documentElement.append(panel);
  const note = panel.querySelector('#quill-collector-detail');
  const relevance = createQuillRelevance({ background, extractArticle,
    onSaved: item => { collected.add(item.url); revision++; update(`${collected.size} relevant/review posts saved · no keyword filtering`); },
    onStatus: (message, busy) => { if (mode === 'feed' || busy) { panel.hidden = false; update(message); } }
  });
  async function background(type, extra = {}) {
    const response = await chrome.runtime.sendMessage({ type, ...extra });
    if (!response?.ok) throw Object.assign(Error(response?.error || 'Could not reach Quill.'), { code: response?.code, retryAt: response?.retryAt }); return response.data;
  }
  async function loadRules() { rules = (await background('QUILL_GET_RULES')).rules; actions(); }
  function update(message) {
    panel.querySelector('#quill-collector-count').textContent = lastMode === 'feed' ? collected.size : items.size;
    panel.querySelector('#quill-collector-title').textContent = mode === 'feed' ? 'Feed collection running' : mode === 'profile' ? 'Profile capture running' : scanning ? 'Article capture running' : 'Collection stopped';
    panel.querySelector('.quill-collector-note').textContent = lastMode === 'feed' ? 'Matches are saved in Replies.' : 'This capture exports JSON.';
    if (message) note.textContent = message;
  }
  function snapshot() { return { apiVersion: 2, version: '0.6.13', analysis: relevance.analysisStatus(), count: lastMode === 'feed' ? collected.size : items.size, mode, semanticBusy: relevance.collecting(), scanning, revision, inspected, sourceUrl, failures: [...failures], articleProgress, message: note.textContent }; }
  function exportJSON() { return JSON.stringify({ schemaVersion: 2, exportedAt: new Date().toISOString(), sourceUrl, completeness: 'partial: only content exposed by X during this capture; hidden or unloaded content can be missing', failures, items: [...items.values()] }, null, 2); }
  function download() {
    if (lastMode === 'feed') throw Error('Feed matches are saved in Replies. Select a profile or article capture to export.');
    const url = URL.createObjectURL(new Blob([exportJSON()], { type: 'application/json' }));
    const a = document.createElement('a'); a.href = url; a.download = `quill-capture-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 30000);
    update('JSON download requested. Check Chrome Downloads.');
  }
  async function stop() {
    if (scanning) throw Error('The article scan is running. It downloads when complete.');
    const stoppedMode = mode; mode = null; clearTimeout(timer); timer = null;
    await relevance.stopCollection();
    await captureTail;
    if (stoppedMode === 'profile') { download(); update('Profile capture stopped. JSON download requested.'); }
    else update('Feed collection stopped. Your candidates are saved in Replies.');
  }
  // Topic selection, chips, and collapse state are owned by relevance.js.
  function keep(item) {
    const previous = items.get(item.url);
    if (previous) {
      item.text = item.text.length >= previous.text.length ? item.text : previous.text;
      item.raw.media = [...new Map([...(previous.raw?.media || []), ...(item.raw?.media || [])].map(m => [m.url, m])).values()];
      item.reply = item.reply ?? previous.reply; item.publishedAt ||= previous.publishedAt;
    }
    items.set(item.url, item); revision++;
  }
  function capture(captureMode = mode) {
    if (!captureMode) return captureTail;
    // Read the DOM at the scroll event, before X can recycle these posts.
    const sources = captureMode === 'feed' ? relevance.loadedSources() : [...document.querySelectorAll('article')].map(extractArticle).filter(Boolean);
    if (captureMode === 'feed') return relevance.collect(sources);
    const work = async () => {
      for (const item of sources) {
        if (captureMode === 'profile') keep(item);
      }
      inspected += sources.length; panel.hidden = false;
      update(captureMode === 'feed' ? `${collected.size} saved · scroll manually to collect more` : `${items.size} captured · scroll manually`);
    };
    const task = captureTail.catch(() => {}).then(work);
    captureTail = task.catch(error => { mode = null; update(error.message); throw error; });
    captureTail.catch(() => {}); return task;
  }
  function actions() {
    relevance.refresh();
    if (isArticlesTab()) {
      if (articleSource !== location.pathname) { discoveredArticles.clear(); articleSource = location.pathname; }
      collectArticleCandidateUrlsOnPage().forEach(url => discoveredArticles.add(url));
    }
    for (const article of document.querySelectorAll('article')) {
      const item = extractArticle(article); if (!item) continue;
      const nativeReply = article.querySelector('[data-testid="reply"]');
      const actionBar = nativeReply?.closest('[role="group"]') || article.querySelector('[role="group"]');
      if (!actionBar) continue;
      const existing = actionBar.querySelector('.quill-actions');
      if (existing?.dataset.url === item.url) continue;
      existing?.remove();
      const controls = document.createElement('div'); controls.className = 'quill-actions'; controls.dataset.url = item.url;
      for (const [label, className] of [['+ List','quill-list-action'],['Reply','quill-reply-action']]) {
        const button = document.createElement('button'); button.className = `quill-action ${className}`; button.textContent = label;
        button.title = label === '+ List' ? 'Save this source to Replies' : 'Generate a draft in the X reply box';
        button.onclick = async event => {
          event.preventDefault(); event.stopPropagation(); button.disabled = true;
          try {
            const current = extractArticle(article); if (!current || current.url !== controls.dataset.url) throw Error('The post changed. Try again.');
            if (label === 'Reply') {
              if (!event.isTrusted) throw Error('Click Reply to generate a draft.');
              button.textContent = 'Drafting…'; await draftInX(article, current);
            }
            else await background('QUILL_SAVE_CANDIDATES', { items: [current] });
            button.textContent = label === '+ List' ? 'Added' : 'Draft ready';
          } catch (error) { button.textContent = 'Try again'; button.title = error.message; }
          finally { button.disabled = false; }
        };
        controls.append(button);
      }
      actionBar.append(controls);
    }
  }
  let draftingInline = false;
  async function draftInX(article, source, preparedText) {
    if (draftingInline) throw Error('Wait for the current draft.');
    if (document.querySelector('[role="dialog"] [data-testid="tweetTextarea_0"]')) throw Error('Close the open composer first. Your text was kept.');
    const native = article.querySelector('[data-testid="reply"]');
    if (!native) throw Error('The X reply button is unavailable.');
    draftingInline = true;
    try {
      const normalize = value => value.replace(/\s+/g, ' ').trim();
      const sourceId = new URL(source.url).pathname.match(/\/status\/(\d+)/)?.[1];
      const onSourcePage = () => location.pathname.match(/\/status\/(\d+)/)?.[1] === sourceId;
      const inline = onSourcePage();
      if (!inline) native.click();
      let dialog, editor;
      const findEditor = root => {
        const field = root.querySelector('[data-testid="tweetTextarea_0"]');
        return field?.matches('[contenteditable="true"]') ? field : field?.querySelector('[contenteditable="true"]');
      };
      for (let attempt = 0; attempt < 60; attempt++) {
        if (inline) {
          const column = article.closest('[data-testid="primaryColumn"]') || article.closest('main');
          editor = column && [...column.querySelectorAll('[data-testid="tweetTextarea_0"]')].filter(field => !field.closest('[role="dialog"]')).map(field => field.matches('[contenteditable="true"]') ? field : field.querySelector('[contenteditable="true"]')).find(Boolean);
          dialog = column;
        } else {
          dialog = [...document.querySelectorAll('[role="dialog"]')].find(node => findEditor(node));
          editor = dialog && findEditor(dialog);
        }
        if (editor) break;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      if (!editor) throw Error(inline ? 'The reply box below the post has not loaded. Try again.' : 'X did not open its reply composer.');
      const sourceMatches = () => inline
        ? onSourcePage() && article.isConnected && extractArticle(article)?.url === source.url && !editor.closest('[role="dialog"]')
        : [...dialog.querySelectorAll('[data-testid="tweetText"]')].some(node => normalize(node.textContent).includes(normalize(source.text).slice(0, 60)));
      if (!sourceMatches()) throw Error('Could not verify the reply target. No draft was inserted.');
      if (editor.textContent.trim()) throw Error('The reply box already has text. Your text was kept.');
      let edited = false;
      const changed = () => { edited = true; };
      editor.addEventListener('input', changed);
      try {
        const result = preparedText === undefined ? await background('QUILL_DRAFT_INLINE', { source }) : { text: preparedText };
        if (!editor.isConnected || !dialog.isConnected || !sourceMatches()) throw Error('The reply composer changed. No draft was inserted.');
        if (edited || editor.textContent.trim()) throw Error('You edited the reply box. Your text was kept.');
        editor.scrollIntoView({ block: 'center', behavior: 'instant' });
        editor.focus();
        if (!document.execCommand('insertText', false, result.text)) throw Error('X did not accept the draft. Try again.');
        if (normalize(editor.textContent) !== normalize(result.text)) throw Error('Check the reply box. X did not accept the complete draft.');
      } finally { editor.removeEventListener('input', changed); }
    } finally { draftingInline = false; }
  }
  async function scanArticles() {
    scanning = true; lastMode = 'articles'; panel.hidden = false; actions();
    const urls = [...discoveredArticles]; articleProgress = { checked: 0, total: urls.length };
    update(`Scanning ${urls.length} loaded links.`);
    try {
      for (const url of urls) {
        try { const response = await background('QUILL_FETCH_ARTICLE', { url }); if (!response?.item) throw Error('Article body unavailable.'); keep(response.item); }
        catch (error) { failures.push({ url, error: error.message, capturedAt: new Date().toISOString() }); revision++; }
        articleProgress.checked++; update(`Checked ${articleProgress.checked}/${urls.length}.`);
      }
      if (!urls.length) { failures.push({ url: location.href, error: 'No article links loaded. Scroll manually, then scan again.' }); revision++; }
    } finally { scanning = false; download(); update(`Article scan complete. ${failures.length} failures. JSON download requested.`); }
  }
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (_sender.id !== chrome.runtime.id) return;
    if (message.type === 'QUILL_JEV_SETTINGS_CHANGED') {
      relevance.configure().then(() => sendResponse({ ok: true }), error => sendResponse({ ok: false, error: error.message })); return true;
    }
    if (message.type === 'QUILL_PASTE_SAVED') {
      if (_sender.id !== chrome.runtime.id) return;
      const article = [...document.querySelectorAll('article')].find(node => extractArticle(node)?.url === message.source.url);
      if (!article) { sendResponse({ ok: false, retry: true, error: 'The source post has not loaded.' }); return; }
      draftInX(article, message.source, message.text).then(() => sendResponse({ ok: true }), error => sendResponse({ ok: false, error: error.message }));
      return true;
    }
    if (message.type === 'QUILL_EXTRACT_ARTICLE') { sendResponse({ item: captureXArticle(), articleUrls: collectArticleCandidateUrlsOnPage() }); return; }
    if (message.type !== 'QUILL_COMMAND') return;
    Promise.resolve().then(async () => {
      if (message.rules) { rules = message.rules; actions(); }
      if (message.action === 'analyze') { await relevance.startAnalyzing(); }
      else if (message.action === 'stop-analysis') { await relevance.stopAnalyzing(); if (mode === 'feed') await stop(); }
      else if (message.action === 'feed' || message.action === 'profile') {
        if (scanning || (mode && mode !== message.action)) throw Error('Stop the current collection first.');
        if (message.action === 'profile' && (!/^\/[^/]+(?:\/(?:with_replies|media))?\/?$/.test(location.pathname) || /^\/(home|explore|search|notifications|messages|i)(\/|$)/.test(location.pathname))) throw Error('Open an X profile first.');
        if (!message.rules) await loadRules();
        if (message.action === 'feed') await relevance.configure();
        lastMode = message.action; mode = message.action === 'feed' ? null : message.action;
        sourceUrl = location.href; panel.hidden = false; await capture(message.action);
      } else if (message.action === 'visible') { await relevance.configure(); lastMode = 'feed'; await capture('feed'); }
      else if (message.action === 'current') {
        const id = location.pathname.match(/\/status\/(\d+)/)?.[1];
        const current = [...document.querySelectorAll('article')].map(extractArticle).find(item => item && item.xPostId === id);
        if (!current) throw Error('Open a post to save its source.'); await background('QUILL_SAVE_CANDIDATES', { items: [current] }); update('Source saved in Replies.');
      } else if (message.action === 'page') {
        const item = captureXArticle(); if (!item) throw Error('Open an X article reader first.'); lastMode = 'articles'; keep(item); download();
      } else if (message.action === 'stop') await stop();
      else if (message.action === 'articles') {
        if (!isArticlesTab()) throw Error('Open a profile Articles tab first. Scroll manually to load its links.');
        if (mode || scanning) throw Error('Stop the current collection first.');
        sourceUrl = location.href; void scanArticles().catch(error => update(error.message));
      } else if (message.action === 'download') download();
      else if (message.action === 'copy') { if (lastMode === 'feed') throw Error('Feed matches are saved in Replies.'); await navigator.clipboard.writeText(exportJSON()); }
      else if (message.action === 'list') return { ...snapshot(), items: [...items.values()] };
      return snapshot();
    }).then(data => sendResponse({ ok: true, data }), error => sendResponse({ ok: false, error: error.message }));
    return true;
  });
  window.addEventListener('scroll', () => { if (timer) return; timer = setTimeout(() => { timer = null; void capture().catch(error => update(error.message)); actions(); }, 200); }, { passive: true });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') actions(); });
  let actionTimer;
  new MutationObserver(() => { if (!actionTimer) actionTimer = setTimeout(() => { actionTimer = null; actions(); }, 250); }).observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['href'] });
  void relevance.configure().catch(error => { note.textContent = error.message; });
  void loadRules().catch(error => { note.textContent = error.message; });
  function extractArticle(article) {
    const postLink = article.querySelector('time')?.closest('a[href*="/status/"]')?.href || [...article.querySelectorAll('a[href*="/status/"]')].map((anchor) => anchor.href).find((href) => /\/status\/\d+/.test(href));
    if (!postLink || !/^https:\/\/(x|twitter)\.com\/[^/]+\/status\/\d+/.test(postLink)) return null;
    // Stable while collapsed: innerText changes with CSS visibility and can invalidate scores.
    const text = [...article.querySelectorAll('[data-testid="tweetText"]')].map(node => node.textContent || '').join('\n').trim();
    const media = extractMedia(article, text, postLink);
    const articleLinks = articleLinksFrom(article);
    if (!text && !media.length && !articleLinks.length) return null;
    const xPostId = postLink.match(/\/status\/(\d+)/)?.[1];
    const sourceHandle = [...article.querySelectorAll('a[href^="/"]')].map((anchor) => anchor.getAttribute("href")?.split("/")[1]).find((value) => value && !["home", "search", "i", "compose"].includes(value));
    const authorName = article.querySelector('[data-testid="User-Name"]')?.innerText?.split("\n")[0]?.trim();
    return {
      type: "POST",
      url: postLink.match(/^https:\/\/(?:x|twitter)\.com\/[^/]+\/status\/\d+/)?.[0] || postLink,
      xPostId,
      sourceHandle: postLink.match(/\/(?:\/)?(?:x|twitter)\.com\/([^/]+)\/status\//)?.[1] || sourceHandle,
      authorName,
      text,
      publishedAt: article.querySelector("time")?.getAttribute("datetime") || null,
      raw: { capturedFrom: "quill-x", pageUrl: location.href, capturedAt: new Date().toISOString(), completeness: article.querySelector('[data-testid="tweet-text-show-more-link"]') ? "truncated: expand this post and capture again" : "exposed text only", media, articleLinks }
    };
  }

  // /status pages are conversation wrappers. X's canonical /article page has a
  // dedicated read-view container with just the article and its own media.
  // Never turn a wrapper page into a research article.
  function captureXArticle() {
    if (!isXArticlePage()) return null;
    const articleRoot = document.querySelector('[data-testid="twitterArticleReadView"]');
    if (!articleRoot) return null;

    const fullText = cleanText(articleRoot.innerText || articleRoot.textContent || "");
    const lines = fullText.split("\n").filter(Boolean);
    const title = cleanText(lines[0] || "").slice(0, 500);
    const sourceHandle = (lines.find((line) => /^@[A-Za-z0-9_]{1,15}$/.test(line)) || "").slice(1);
    // Keep all text exposed in the reader. Do not require a heading or remove a guessed footer.
    const text = fullText;
    if (!text) return null;

    const url = location.href.replace(/[?#].*$/, "");
    return {
      type: "ARTICLE",
      url,
      sourceHandle: sourceHandle || undefined,
      articleId: location.pathname.match(/articles?\/(\d+)/)?.[1] || null,
      publishedAt: articleRoot.querySelector("time")?.getAttribute("datetime") || null,
      title,
      text,
      raw: {
        capturedFrom: "quill-x-article",
        capturedAt: new Date().toISOString(),
        media: extractMedia(articleRoot, text),
        sourceUrl: url
      }
    };
  }

  function cleanText(value) { return String(value || "").replace(/\r/g, "").split("\n").map((line) => line.trim()).filter(Boolean).join("\n"); }
  function normaliseUrl(value) {
    try { const url = new URL(value, location.href); url.hash = ""; return url.toString(); } catch { return ""; }
  }
  function isXArticleUrl(value) {
    const url = normaliseUrl(value);
    try {
      const parsed = new URL(url);
      return ['x.com', 'twitter.com'].includes(parsed.hostname)
        && (/^\/i\/article\/\d+/.test(parsed.pathname) || /^\/[^/]+\/articles\/\d+/.test(parsed.pathname) || /^\/[^/]+\/article\/\d+/.test(parsed.pathname));
    } catch { return false; }
  }
  function isXArticlePage() { return /^\/[^/]+\/articles?\/\d+/.test(location.pathname) || /^\/i\/article\/\d+/.test(location.pathname); }
  function isXStatusUrl(value) {
    const url = normaliseUrl(value);
    try {
      const parsed = new URL(url);
      return ['x.com', 'twitter.com'].includes(parsed.hostname) && /^\/[^/]+\/status\/\d+/.test(parsed.pathname);
    } catch { return false; }
  }
  function isArticlesTab() { return /^\/[^/]+\/articles\/?$/.test(location.pathname); }
  function articleLinksFrom(scope) {
    const links = new Set();
    scope.querySelectorAll('a[href]').forEach((link) => {
      const url = normaliseUrl(link.getAttribute("href"));
      if (url && isXArticleUrl(url)) links.add(url);
    });
    return [...links];
  }
  // X's Articles tab often links each card to the article's status post rather
  // than to /i/article/... directly. Keep that status URL as a candidate so
  // the background worker can open it and follow the real article link.
  function collectArticleCandidateUrlsOnPage() {
    const links = new Set(articleLinksFrom(document));
    if (!isArticlesTab()) return [...links];
    document.querySelectorAll('article[data-testid="tweet"], [data-testid="cellInnerDiv"]').forEach((card) => {
      const cardLinks = [...card.querySelectorAll('a[href]')];
      const directArticle = cardLinks.find((link) => isXArticleUrl(link.getAttribute("href")));
      if (directArticle) {
        links.add(normaliseUrl(directArticle.getAttribute("href")));
        return;
      }
      const statusPost = cardLinks.find((link) => isXStatusUrl(link.getAttribute("href")));
      if (statusPost) links.add(normaliseUrl(statusPost.getAttribute("href")));
    });
    return [...links];
  }
  function normaliseMediaUrl(value) {
    try { const url = new URL(value, location.href); url.hash = ""; return url.toString(); } catch { return ""; }
  }
  function extractMedia(scope, context, sourceUrl = location.href.replace(/[?#].*$/, "")) {
    const media = [];
    const seen = new Set();
    const add = (type, url, alt = "", extra = {}) => {
      const cleanUrl = normaliseMediaUrl(url);
      const key = `${type}:${cleanUrl}`;
      if (!cleanUrl || cleanUrl.startsWith("blob:") || seen.has(key)) return;
      seen.add(key);
      media.push({ type, url: cleanUrl, alt: cleanText(alt), description: cleanText(alt || context).slice(0, 1200), sourceUrl, ...extra });
    };
    scope.querySelectorAll("img[src]").forEach((img) => {
      const src = img.currentSrc || img.src || img.getAttribute("src") || "";
      if (!src || /profile_images|emoji\/v2|abs-0\.twimg\.com/i.test(src)) return;
      add("image", src, img.getAttribute("alt") || "");
    });
    scope.querySelectorAll("video").forEach((video) => {
      const poster = video.getAttribute("poster") || "";
      const source = video.currentSrc || video.src || "";
      if (source && !source.startsWith("blob:")) add("video", source, "Video", poster ? { posterUrl: normaliseMediaUrl(poster) } : {});
      else if (poster) add("video", poster, "Video preview", { posterUrl: normaliseMediaUrl(poster), playableOnSource: true });
      video.querySelectorAll("source[src]").forEach((node) => add("video", node.getAttribute("src") || "", "Video", poster ? { posterUrl: normaliseMediaUrl(poster) } : {}));
    });
    return media;
  }


})();
