// @ts-check
(function () {
  'use strict';

  /**
   * ニコニコ動画視聴ページからデータを抽出してbackground scriptに送信
   */
  /**
   * ページDOMからAPIデータJSONを取得する
   * 方法1: #js-initial-watch-data の data-api-data 属性（旧形式）
   * 方法2: <meta name="server-response"> の content 属性（新形式）
   * @returns {object|null}
   */
  function extractApiData() {
    // 方法1: 旧形式 (#js-initial-watch-data)
    const legacyElem = document.querySelector('#js-initial-watch-data');
    if (legacyElem) {
      const raw = legacyElem.getAttribute('data-api-data');
      if (raw) {
        try {
          return JSON.parse(raw);
        } catch (e) {
          console.error('[NicoCommentDL] Failed to parse data-api-data:', e);
        }
      }
    }

    // 方法2: 新形式 (<meta name="server-response">)
    const metaElems = document.querySelectorAll('meta[name="server-response"]');
    for (const meta of metaElems) {
      const content = meta.getAttribute('content');
      if (!content) continue;
      let parsed = null;
      try { parsed = JSON.parse(content); } catch (_) {}
      // URL エンコードされている場合
      if (!parsed) {
        try { parsed = JSON.parse(decodeURIComponent(content)); } catch (_) {}
      }
      if (!parsed) continue;
      // media.domand が含まれているパスを優先して探す
      const candidates = [
        parsed?.data?.response,
        parsed?.data,
        parsed?.response,
        parsed,
      ];
      for (const c of candidates) {
        if (c?.media?.domand) {
          console.log('[NicoCommentDL] Watch data found via meta[server-response]');
          return c;
        }
      }
    }

    // 方法3: ページ内 <script> タグの JSON データを探す
    for (const script of document.querySelectorAll('script')) {
      const text = script.textContent || '';
      if (!text.includes('accessRightKey') && !text.includes('domand')) continue;
      const match = text.match(/\bwindow\.__INITIAL_WATCH_DATA__\s*=\s*({.+?});/s)
        || text.match(/\bwindow\.__STORE__\s*=\s*({.+?});/s);
      if (match) {
        try {
          const obj = JSON.parse(match[1]);
          if (obj?.media?.domand) return obj;
          if (obj?.data?.response?.media?.domand) return obj.data.response;
        } catch (_) {}
      }
    }

    return null;
  }

  function extractWatchData(silent = false) {
    const apiData = extractApiData();
    if (!apiData) {
      if (!silent) console.warn('[NicoCommentDL] Could not extract watch data from page');
      return null;
    }

    const videoInfo = {
      videoId: apiData.video?.id,
      title: apiData.video?.title,
      duration: apiData.video?.duration,
      thumbnail: apiData.video?.thumbnail?.url,
    };

    const hlsInfo = {
      accessRightKey: apiData.media?.domand?.accessRightKey,
      videos: apiData.media?.domand?.videos || [],
      audios: apiData.media?.domand?.audios || [],
    };

    const commentInfo = {
      nvComment: apiData.comment?.nvComment || null,
    };

    return { videoInfo, hlsInfo, commentInfo };
  }

  // Background scriptからのリクエストをリッスン
  browser.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === 'EXTRACT_WATCH_DATA') {
      const data = extractWatchData();
      sendResponse(data);
      return false;
    }

    // Background scriptの代わりにcontent scriptのコンテキストでfetchを実行する
    // content scriptはhost_permissionsがあればcredentials付きクロスオリジンfetchが可能
    // Firefox MV2・Chrome MV3どちらでも動作する（インラインscript注入不要）
    if (message.type === 'PROXY_FETCH') {
      const { url, init } = message;
      (async () => {
        try {
          const res = await fetch(url, { ...init, credentials: 'include' });
          const text = await res.text();
          let data;
          try { data = JSON.parse(text); } catch (_) { data = text; }
          sendResponse({ ok: res.ok, status: res.status, data });
        } catch (err) {
          sendResponse({ ok: false, status: 0, error: err.message });
        }
      })();
      return true; // 非同期sendResponseのため true を返す
    }

    return false;
  });

  // ページ読み込み完了時にbackgroundに通知
  // ニコニコ動画はSPAのため、document_idle 後でもJSハイドレーションが完了していない場合がある
  // 指数バックオフ付きで最大6回リトライする（500ms → 1s → 2s → 3s → 3s → 3s）
  (async function tryExtract() {
    const delays = [0, 500, 1000, 2000, 3000, 3000];
    for (let i = 0; i < delays.length; i++) {
      if (delays[i] > 0) await new Promise(r => setTimeout(r, delays[i]));
      const data = extractWatchData(true); // 自動リトライ中は警告を抑制
      if (data) {
        browser.runtime.sendMessage({ type: 'WATCH_DATA_READY', data }).catch(() => {});
        return;
      }
    }
    console.warn('[NicoCommentDL] Watch data not found after retries');
  })();
})();
