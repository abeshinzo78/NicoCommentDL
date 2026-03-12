// @ts-check
// Chrome MV3 Service Worker - thin router
// WebCodecs / OffscreenCanvas などDOM依存の処理は offscreen document に委譲

/** @type {Map<number, any>} tabId -> watchData */
const tabData = new Map();

let offscreenCreating = false;

async function ensureOffscreenDocument() {
  const existing = await chrome.offscreen.hasDocument();
  if (existing) return;
  if (offscreenCreating) {
    // 作成中なら待つ
    await new Promise(resolve => setTimeout(resolve, 200));
    return ensureOffscreenDocument();
  }
  offscreenCreating = true;
  try {
    await chrome.offscreen.createDocument({
      url: 'src/offscreen/offscreen.html',
      reasons: ['BLOBS'],
      justification: 'WebCodecs VideoDecoder/Encoder and Canvas2D for video+comment compositing, Blob URL creation for download',
    });
  } finally {
    offscreenCreating = false;
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.type) {

    case 'WATCH_DATA_READY': {
      const tabId = sender.tab?.id;
      if (tabId != null) {
        tabData.set(tabId, message.data);
      }
      return false;
    }

    case 'EXTRACT_WATCH_DATA': {
      // popup → SW → content script
      chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
        const tab = tabs[0];
        if (!tab?.id) { sendResponse(null); return; }
        try {
          const data = await chrome.tabs.sendMessage(tab.id, { type: 'EXTRACT_WATCH_DATA' });
          if (data) tabData.set(tab.id, data);
          sendResponse(data);
        } catch (e) {
          sendResponse(null);
        }
      });
      return true; // async sendResponse
    }

    case 'GET_WATCH_DATA': {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const tab = tabs[0];
        const data = tab?.id != null ? (tabData.get(tab.id) ?? null) : null;
        sendResponse(data);
      });
      return true;
    }

    case 'START_DOWNLOAD': {
      const { tabId, preferredQuality } = message.data;
      (async () => {
        let watchData = tabId != null ? tabData.get(tabId) : null;
        if (!watchData && tabId != null) {
          try {
            watchData = await chrome.tabs.sendMessage(tabId, { type: 'EXTRACT_WATCH_DATA' });
            if (watchData) tabData.set(tabId, watchData);
          } catch (e) {
            console.error('[sw-chrome] EXTRACT_WATCH_DATA failed:', e);
          }
        }
        if (!watchData) {
          chrome.runtime.sendMessage({
            type: 'DOWNLOAD_PROGRESS',
            data: { stage: 'error', message: 'エラー：動画情報が取得できませんでした', current: 0, total: 0, percent: 0 },
          }).catch(() => {});
          return;
        }
        await ensureOffscreenDocument();
        chrome.runtime.sendMessage({
          type: 'OFFSCREEN_START_DOWNLOAD',
          data: { watchData, preferredQuality, tabId },
        }).catch(() => {});
      })();
      sendResponse({ ok: true });
      return false;
    }

    case 'GET_STATUS': {
      // offscreen document に問い合わせて結果を返す
      ensureOffscreenDocument().then(() => {
        chrome.runtime.sendMessage({ type: 'OFFSCREEN_GET_STATUS' })
          .then(res => sendResponse(res))
          .catch(() => sendResponse({ progress: null }));
      }).catch(() => sendResponse({ progress: null }));
      return true;
    }

    default:
      return false;
  }
});

// SW keepalive（30秒タイムアウト防止）
chrome.alarms.create('swKeepAlive', { periodInMinutes: 0.4 });
chrome.alarms.onAlarm.addListener(() => {});
