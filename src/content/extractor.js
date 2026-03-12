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
      try {
        const parsed = JSON.parse(content);
        // 新形式: { meta: { status: 200 }, data: { response: { ... } } }
        if (parsed?.data?.response) {
          return parsed.data.response;
        }
      } catch (e) {
        // このmetaタグはwatch用でない可能性がある、次を試す
      }
    }

    return null;
  }

  function extractWatchData() {
    const apiData = extractApiData();
    if (!apiData) {
      console.warn('[NicoCommentDL] Could not extract watch data from page');
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
  const data = extractWatchData();
  if (data) {
    browser.runtime.sendMessage({
      type: 'WATCH_DATA_READY',
      data,
    }).catch(() => {
      // popup未オープン時はエラーになるが無視
    });
  }
})();
