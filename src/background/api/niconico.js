// @ts-check

/**
 * JWTペイロードをデコードする（署名検証なし、ペイロード読み取り専用）
 * @param {string} jwt
 * @returns {object|null}
 */
function decodeJwtPayload(jwt) {
  try {
    const parts = jwt.split('.');
    if (parts.length !== 3) return null;
    // base64url → standard base64
    let base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    // パディング追加（atobはパディングが必要な場合がある）
    while (base64.length % 4 !== 0) {
      base64 += '=';
    }
    const json = atob(base64);
    return JSON.parse(json);
  } catch (e) {
    console.warn('[NicoCommentDL] JWT decode failed:', e);
    return null;
  }
}

/**
 * accessRightKey JWTから許可された画質・音質IDリストを取得する
 * JWTペイロードの "v" (video) と "a" (audio) 配列を読み取る
 * @param {string} accessRightKey
 * @returns {{ videos: string[], audios: string[] } | null}
 */
export function getAuthorizedQualities(accessRightKey) {
  const payload = decodeJwtPayload(accessRightKey);
  if (!payload) return null;
  return {
    videos: payload.v || [],
    audios: payload.a || [],
  };
}

/**
 * actionTrackIdを生成する（ランダム文字列 + タイムスタンプ）
 * @returns {string}
 */
function generateActionTrackId() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let id = '';
  for (let i = 0; i < 10; i++) {
    id += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return `${id}_${Date.now()}`;
}

/**
 * HLS URLを取得する
 * @param {string} videoId
 * @param {string} accessRightKey - JWT
 * @param {[string, string]} output - 画質・音質ペア（1つ）
 * @param {object} [options]
 * @param {string} [options.actionTrackId] - トラッキング用ID（省略時は自動生成）
 * @param {Function} [options.fetchFn] - fetch関数（テスト/プロキシ用）
 * @returns {Promise<{ contentUrl: string, createTime: string, expireTime: string }>}
 */
export async function fetchHlsUrl(videoId, accessRightKey, output, options = {}) {
  const { fetchFn = globalThis.fetch.bind(globalThis) } = options;
  const actionTrackId = options.actionTrackId || generateActionTrackId();

  const url = `https://nvapi.nicovideo.jp/v1/watch/${videoId}/access-rights/hls?actionTrackId=${encodeURIComponent(actionTrackId)}`;

  const requestBody = {
    outputs: [output],
  };

  const response = await fetchFn(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Access-Right-Key': accessRightKey,
      'X-Frontend-Id': '6',
      'X-Frontend-Version': '0',
      'X-Request-With': `https://www.nicovideo.jp/watch/${videoId}`,
    },
    credentials: 'include',
    body: JSON.stringify(requestBody),
  });

  const json = await response.json();

  if (!response.ok) {
    const detail = JSON.stringify(json);
    throw new Error(`HLS API ${response.status}: ${detail} | sent: ${JSON.stringify(requestBody)}`);
  }

  if (json.meta?.status !== 201) {
    throw new Error(`HLS API unexpected status: ${json.meta?.status} ${JSON.stringify(json)}`);
  }

  return json.data;
}

/**
 * コメントを取得する
 * @param {object} nvComment - apiDataのcomment.nvComment
 * @param {object} [options]
 * @param {Function} [options.fetchFn] - fetch関数（テスト/プロキシ用）
 * @returns {Promise<object>} threads data
 */
export async function fetchComments(nvComment, options = {}) {
  const { fetchFn = globalThis.fetch.bind(globalThis) } = options;
  const { threadKey, server, params } = nvComment;

  const url = `${server}/v1/threads`;

  const response = await fetchFn(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-frontend-id': '6',
      'x-frontend-version': '0',
    },
    body: JSON.stringify({
      params,
      threadKey,
      additionals: {},
    }),
  });

  if (!response.ok) {
    throw new Error(`Comment API failed: ${response.status} ${response.statusText}`);
  }

  const json = await response.json();
  if (json.meta?.status !== 200) {
    throw new Error(`Comment API returned unexpected status: ${json.meta?.status}`);
  }

  return json.data;
}

/**
 * 画質・音質の出力ペアを生成する
 * @param {Array<{id: string, isAvailable: boolean}>} videos
 * @param {Array<{id: string, isAvailable: boolean}>} audios
 * @param {string} [preferredVideo] - 希望画質ID
 * @returns {Array<[string, string]>} 利用可能なペアリスト（先頭が希望画質）
 */
export function buildOutputs(videos, audios, preferredVideo) {
  const availableVideos = videos.filter(v => v.isAvailable).map(v => v.id);
  const availableAudios = audios.filter(a => a.isAvailable).map(a => a.id);

  if (availableVideos.length === 0 || availableAudios.length === 0) {
    throw new Error('No available video/audio qualities');
  }

  // 希望画質がなければ最高画質
  const targetVideo = preferredVideo && availableVideos.includes(preferredVideo)
    ? preferredVideo
    : availableVideos[0];

  const bestAudio = availableAudios[0];

  // メインの出力 + フォールバック
  /** @type {Array<[string, string]>} */
  const outputs = [[targetVideo, bestAudio]];

  // フォールバック用に他の画質も追加
  for (const vid of availableVideos) {
    if (vid !== targetVideo) {
      outputs.push([vid, bestAudio]);
    }
  }

  return outputs;
}
