let jevPanelConfig = { enabled: false, feed: false }, jevRanking = false, stopJevRanking = false;
let jevTesting = false;
function showJevHealth(health = { state: 'unchecked', message: 'Connection not tested yet.' }) {
  jevPanelConfig.health = health;
  for (const suffix of ['View', 'Settings']) {
    $(`jevHealth${suffix}`).textContent = !jevPanelConfig.enabled ? 'Relevance off. Enable Jev in Settings.' : `${health.state === 'paused' ? 'Relevance paused · ' : ''}${health.message}`;
    const button = $(`jevRetry${suffix}`);
    button.textContent = jevTesting ? 'Testing…' : health.state === 'paused' ? 'Retry connection' : 'Test connection';
    button.disabled = jevTesting || !jevPanelConfig.enabled || !jevPanelConfig.keyConfigured;
  }
  $('jevBadge').textContent = !jevPanelConfig.enabled ? 'Off' : health.state === 'paused' ? 'Paused' : health.state === 'ready' ? 'Connected' : health.state === 'checking' ? 'Checking' : 'Not tested';
}
function showJevConfig(config) {
  jevPanelConfig = config;
  $('jevBadge').textContent = config.enabled ? 'Enabled' : 'Off';
  $('jevEnabled').checked = config.enabled;
  $('jevZdr').checked = config.zeroDataRetention !== false;
  $('jevHideView').checked = Boolean(config.hideIrrelevant);
  $('jevBrief').value = config.brief;
  $('jevLimit').value = config.dailyLimit;
  $('jevUsage').textContent = `${config.usedToday} / ${config.dailyLimit} requests today · ${config.keyConfigured ? 'Gateway key saved' : 'Gateway key needed'}`;
  $('jevCaptureHint').textContent = 'One click checks only the posts already loaded now, applies results together, then stops. Scrolling and Hide/Show never analyze more posts.';
  showJevHealth(config.health);
}
document.addEventListener('DOMContentLoaded', async () => {
  const testConnection = async () => {
    if (jevTesting) return;
    jevTesting = true; showJevHealth({ state: 'checking', message: 'Testing one sample post…' });
    try { showJevHealth(await background('QUILL_JEV_TEST')); }
    catch (error) { showJevHealth({ state: error.code === 'jev_wait' ? 'waiting' : 'paused', message: error.message, retryAt: error.retryAt }); }
    finally { jevTesting = false; showJevHealth(jevPanelConfig.health); }
  };
  $('jevRetryView').onclick = testConnection;
  $('jevRetrySettings').onclick = testConnection;
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.jevHealthV1?.newValue) showJevHealth(changes.jevHealthV1.newValue);
    if (area === 'local' && changes.jevUsage?.newValue) {
      const usage = changes.jevUsage.newValue;
      jevPanelConfig.usedToday = usage.day === new Date().toISOString().slice(0, 10) ? usage.requests : 0;
      $('jevUsage').textContent = `${jevPanelConfig.usedToday} / ${jevPanelConfig.dailyLimit} requests today · Gateway key saved`;
    }
  });
  $('jevFocusPreset').onclick = () => { if (jevPanelConfig.focusPreset) { $('jevBrief').value = jevPanelConfig.focusPreset; status('jevStatus', 'AI ads, e-commerce, AI video, UGC and creator-video focus loaded. Review and Save to apply.'); } };
  $('jevAnalyze').onclick = () => run($('jevAnalyze'), 'jevViewStatus', async () => {
    if (captureState.version !== '0.6.13') throw Error('Reload this X tab to activate click-to-start analysis. Saved replies are kept.');
    await command(captureState.analysis?.running ? 'stop-analysis' : 'analyze');
    status('jevViewStatus', ''); await refresh(true);
  });
  const saveView = async () => {
    $('jevHideView').disabled = true;
    try {
      showJevConfig(await background('QUILL_JEV_SET_VIEW', { settings: { hideIrrelevant: $('jevHideView').checked } }));
      status('jevViewStatus', 'Applied to checked posts. This switch does not start analysis.');
    } catch (error) { showJevConfig(jevPanelConfig); status('jevViewStatus', error.message); }
    finally { $('jevHideView').disabled = false; }
  };
  $('jevHideView').onchange = saveView;
  $('jevForm').onsubmit = event => {
    event.preventDefault();
    void run($('saveJev'), 'jevStatus', async () => {
      showJevConfig(await background('QUILL_JEV_SAVE', { settings: { key: $('jevKey').value, brief: $('jevBrief').value, enabled: $('jevEnabled').checked, zeroDataRetention: $('jevZdr').checked, feed: false, hideIrrelevant: jevPanelConfig.hideIrrelevant || false, dailyLimit: Number($('jevLimit').value) } }));
      $('jevKey').value = ''; status('jevStatus', 'Saved and applied to open X tabs. Changed interests clear old chips. Gemini is unchanged.'); await refresh(true);
    });
  };
  $('clearJevKey').onclick = () => run($('clearJevKey'), 'jevStatus', async () => { showJevConfig(await background('QUILL_JEV_CLEAR_KEY')); $('jevKey').value = ''; status('jevStatus', 'Gateway key removed; Jev disabled. Tweets and Gemini settings kept.'); await refresh(true); });
  $('jevSort').onchange = renderQueue;
  $('stopJev').onclick = () => { stopJevRanking = true; status('jevQueueStatus', 'Stopping after the current evaluation…'); };
  $('rankJev').onclick = () => run($('rankJev'), 'jevQueueStatus', async () => {
    if (jevRanking) return;
    jevRanking = true; stopJevRanking = false; $('stopJev').hidden = false;
    let completed = 0;
    try {
      const config = await background('QUILL_JEV_CONFIG');
      if (!config.enabled) throw Error('Enable Jev and add a Gateway key in Settings first.');
      const posts = (await background('QUILL_LIST_CANDIDATES')).items.filter(item => item.type === 'POST' && !item.jev);
      for (const item of posts) {
        if (stopJevRanking) break;
        status('jevQueueStatus', `Evaluating ${completed + 1} of ${posts.length}… Keep this panel open.`);
        const expiresAt = Date.now() + 300000;
        while (!stopJevRanking) {
          try { await background('QUILL_JEV_RANK', { url: item.url }); completed++; break; }
          catch (error) {
            if (error.code !== 'jev_wait' || Date.now() >= expiresAt) throw error;
            const retryAt = Math.min(expiresAt, error.retryAt || Date.now() + 2500);
            while (!stopJevRanking && Date.now() < retryAt) {
              status('jevQueueStatus', `${completed} / ${posts.length} checked · waiting ${Math.ceil((retryAt - Date.now()) / 1000)}s`);
              await new Promise(resolve => setTimeout(resolve, 250));
            }
          }
        }
      }
      $('jevSort').value = 'jev';
      status('jevQueueStatus', `${completed} evaluated. ${stopJevRanking ? 'Ranking stopped. ' : ''}All saved tweets and drafts kept. Existing current scores are reused.`);
    } finally { jevRanking = false; $('stopJev').hidden = true; await refresh(true); showJevConfig(await background('QUILL_JEV_CONFIG')); }
  });
  try { showJevConfig(await background('QUILL_JEV_CONFIG')); } catch (error) { status('jevStatus', error.message); }
});
