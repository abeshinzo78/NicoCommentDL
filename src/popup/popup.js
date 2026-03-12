// @ts-check
(function () {
  'use strict';

  const videoInfoPanel = document.getElementById('video-info');
  const notNicoPanel = document.getElementById('not-nico');
  const videoTitle = document.getElementById('video-title');
  const videoId = document.getElementById('video-id');
  const qualityButtons = document.getElementById('quality-buttons');
  const downloadBtn = document.getElementById('download-btn');
  const progressSection = document.getElementById('progress-section');
  const progressFill = document.getElementById('progress-fill');
  const progressText = document.getElementById('progress-text');

  let selectedQuality = null;
  let currentTabId = null;

  async function init() {
    // 現在のタブ情報を取得
    const tabs = await browser.tabs.query({ active: true, currentWindow: true });
    const tab = tabs[0];

    if (!tab || !tab.url || !tab.url.includes('nicovideo.jp/watch/')) {
      notNicoPanel.classList.remove('hidden');
      return;
    }

    currentTabId = tab.id;

    // Content scriptからデータ取得を試みる
    try {
      const watchData = await browser.tabs.sendMessage(tab.id, { type: 'EXTRACT_WATCH_DATA' });
      if (watchData) {
        showVideoInfo(watchData);
        return;
      }
    } catch {
      // Content scriptが応答しない
    }

    // Background scriptのキャッシュを確認
    try {
      const cached = await browser.runtime.sendMessage({
        type: 'GET_WATCH_DATA',
        data: { tabId: tab.id },
      });
      if (cached) {
        showVideoInfo(cached);
        return;
      }
    } catch {
      // noop
    }

    notNicoPanel.classList.remove('hidden');
  }

  /**
   * @param {any} watchData
   */
  function showVideoInfo(watchData) {
    const { videoInfo, hlsInfo } = watchData;

    videoInfoPanel.classList.remove('hidden');
    videoTitle.textContent = videoInfo.title || '不明';
    videoId.textContent = videoInfo.videoId || '不明';

    // 画質ボタンを生成
    const videos = (hlsInfo.videos || []).filter(v => v.isAvailable);
    qualityButtons.innerHTML = '';

    if (videos.length === 0) {
      const btn = document.createElement('button');
      btn.className = 'quality-btn active';
      btn.textContent = '自動';
      qualityButtons.appendChild(btn);
    } else {
      videos.forEach((v, i) => {
        const btn = document.createElement('button');
        btn.className = 'quality-btn' + (i === 0 ? ' active' : '');
        btn.textContent = formatQualityLabel(v.id);
        btn.dataset.qualityId = v.id;
        btn.addEventListener('click', () => selectQuality(btn, v.id));
        qualityButtons.appendChild(btn);
      });
      selectedQuality = videos[0].id;
    }

    // 進捗状態を確認
    checkProgress();
  }

  /**
   * @param {HTMLElement} btn
   * @param {string} qualityId
   */
  function selectQuality(btn, qualityId) {
    document.querySelectorAll('.quality-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    selectedQuality = qualityId;
  }

  /**
   * 画質IDから表示ラベルを生成
   * @param {string} id - "video-h264-720p" など
   * @returns {string}
   */
  function formatQualityLabel(id) {
    const match = id.match(/(\d+p(?:-lowest)?)/);
    return match ? match[1] : id;
  }

  // ダウンロードボタン
  downloadBtn.addEventListener('click', async () => {
    if (!currentTabId) return;

    downloadBtn.disabled = true;
    progressSection.classList.remove('hidden');
    progressText.textContent = '開始中...';
    progressText.className = 'progress-text';
    progressFill.style.width = '0%';

    try {
      await browser.runtime.sendMessage({
        type: 'START_DOWNLOAD',
        data: {
          tabId: currentTabId,
          preferredQuality: selectedQuality,
        },
      });
    } catch (e) {
      progressText.textContent = `エラー: ${e.message}`;
      progressText.className = 'progress-text error';
      downloadBtn.disabled = false;
    }
  });

  // 進捗更新を受信
  browser.runtime.onMessage.addListener((message) => {
    if (message.type === 'DOWNLOAD_PROGRESS') {
      const progress = message.data;
      updateProgressUI(progress);
    }
  });

  /**
   * @param {any} progress
   */
  function updateProgressUI(progress) {
    if (!progress) return;

    progressSection.classList.remove('hidden');
    progressFill.style.width = `${progress.percent}%`;
    progressText.textContent = progress.message;

    if (progress.stage === 'error') {
      progressText.className = 'progress-text error';
      downloadBtn.disabled = false;
    } else if (progress.stage === 'complete') {
      progressText.className = 'progress-text complete';
      downloadBtn.disabled = false;
    } else {
      progressText.className = 'progress-text';
    }
  }

  async function checkProgress() {
    try {
      const status = await browser.runtime.sendMessage({ type: 'GET_STATUS' });
      if (status?.progress) {
        updateProgressUI(status.progress);
        if (status.progress.stage !== 'complete' && status.progress.stage !== 'error') {
          downloadBtn.disabled = true;
        }
      }
    } catch {
      // noop
    }
  }

  init();
})();
