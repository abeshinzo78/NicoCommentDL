// @ts-check

// 並列ダウンロード数（メモリ余裕があるため大きく設定）
const DEFAULT_CONCURRENCY = 32;
const MAX_CONCURRENCY = 64;

/**
 * @typedef {object} HlsSegment
 * @property {string} url
 * @property {number} duration
 * @property {string} [keyUrl]
 * @property {Uint8Array} [iv]
 */

/**
 * @typedef {object} HlsVariant
 * @property {string} url
 * @property {number} bandwidth
 * @property {string} [resolution]
 * @property {string} [codecs]
 * @property {string} [audio]
 * @property {number} [frameRate]
 */

/**
 * マスター playlist を解析してバリアント一覧を取得
 * @param {string} masterUrl
 * @returns {Promise<{ variants: HlsVariant[], audioUrl: string | null }>}
 */
export async function parseMasterPlaylist(masterUrl) {
  const text = await fetchText(masterUrl);
  return parseMasterM3u8(text, masterUrl);
}

/**
 * マスター m3u8 テキストをパース
 * @param {string} text
 * @param {string} baseUrl
 * @returns {{ variants: HlsVariant[], audioUrl: string | null }}
 */
export function parseMasterM3u8(text, baseUrl) {
  const lines = text.split('\n').map(l => l.trim());
  const variants = [];
  let audioUrl = null;

  // EXT-X-MEDIA で audio を探す
  for (const line of lines) {
    if (line.startsWith('#EXT-X-MEDIA:')) {
      const attrs = parseAttributes(line.substring('#EXT-X-MEDIA:'.length));
      if (attrs.TYPE === 'AUDIO' && attrs.URI) {
        audioUrl = resolveUrl(attrs.URI, baseUrl);
      }
    }
  }

  // EXT-X-STREAM-INF でバリアントを探す
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('#EXT-X-STREAM-INF:')) {
      const attrs = parseAttributes(lines[i].substring('#EXT-X-STREAM-INF:'.length));
      const url = resolveUrl(lines[i + 1], baseUrl);
      variants.push({
        url,
        bandwidth: parseInt(attrs.BANDWIDTH || '0', 10),
        resolution: attrs.RESOLUTION || '',
        codecs: attrs.CODECS || '',
        audio: attrs.AUDIO || '',
        frameRate: attrs['FRAME-RATE'] ? parseFloat(attrs['FRAME-RATE']) : undefined,
      });
    }
  }

  return { variants, audioUrl };
}

/**
 * メディア playlist を解析してセグメント一覧を取得
 * @param {string} mediaUrl
 * @returns {Promise<{ initSegmentUrl: string | null, segments: HlsSegment[] }>}
 */
export async function parseMediaPlaylist(mediaUrl) {
  const text = await fetchText(mediaUrl);
  return parseMediaM3u8(text, mediaUrl);
}

/**
 * メディア m3u8 テキストをパース
 * @param {string} text
 * @param {string} baseUrl
 * @returns {{ initSegmentUrl: string | null, segments: HlsSegment[] }}
 */
export function parseMediaM3u8(text, baseUrl) {
  const lines = text.split('\n').map(l => l.trim());
  /** @type {HlsSegment[]} */
  const segments = [];
  let initSegmentUrl = null;
  let currentKeyUrl = null;
  /** @type {Uint8Array | null} */
  let currentIv = null;
  let currentDuration = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.startsWith('#EXT-X-MAP:')) {
      const attrs = parseAttributes(line.substring('#EXT-X-MAP:'.length));
      if (attrs.URI) {
        initSegmentUrl = resolveUrl(attrs.URI, baseUrl);
      }
    } else if (line.startsWith('#EXT-X-KEY:')) {
      const attrs = parseAttributes(line.substring('#EXT-X-KEY:'.length));
      if (attrs.METHOD === 'AES-128' && attrs.URI) {
        currentKeyUrl = resolveUrl(attrs.URI, baseUrl);
        if (attrs.IV) {
          currentIv = parseIV(attrs.IV);
        } else {
          currentIv = null;
        }
      } else if (attrs.METHOD === 'NONE') {
        currentKeyUrl = null;
        currentIv = null;
      }
    } else if (line.startsWith('#EXTINF:')) {
      const match = line.match(/#EXTINF:([\d.]+)/);
      if (match) {
        currentDuration = parseFloat(match[1]);
      }
    } else if (line && !line.startsWith('#')) {
      segments.push({
        url: resolveUrl(line, baseUrl),
        duration: currentDuration,
        keyUrl: currentKeyUrl || undefined,
        iv: currentIv || undefined,
      });
    }
  }

  return { initSegmentUrl, segments };
}

/**
 * セグメントを並列プリフェッチしつつ順次処理する
 * チャンク処理によりメモリ圧を低減
 * @param {string | null} initSegmentUrl
 * @param {HlsSegment[]} segments
 * @param {(data: ArrayBuffer, index: number, total: number) => Promise<void>} onSegment
 * @param {{ concurrency?: number, initData?: ArrayBuffer }} [options]
 * @returns {Promise<void>}
 */
export async function forEachSegment(initSegmentUrl, segments, onSegment, options = {}) {
  const concurrency = Math.min(
    options.concurrency || DEFAULT_CONCURRENCY,
    MAX_CONCURRENCY
  );

  // init セグメント取得（キャッシュ済みなら再 fetch しない）
  if (options.initData) {
    await onSegment(options.initData, 0, segments.length);
  } else if (initSegmentUrl) {
    const initData = await fetchArrayBuffer(initSegmentUrl);
    await onSegment(initData, 0, segments.length);
  }

  // 暗号化キーをキャッシュ（CryptoKey としてインポート済み）
  /** @type {Map<string, CryptoKey>} */
  const cryptoKeyCache = new Map();

  // キーの事前フェッチ + インポート（全ユニークキーを先に処理）
  // importKey は非同期で重いため、各キーにつき1回だけ実行
  const uniqueKeyUrls = [...new Set(segments.map(s => s.keyUrl).filter(Boolean))];
  await Promise.all(uniqueKeyUrls.map(async (keyUrl) => {
    const keyData = await fetchArrayBuffer(keyUrl);
    const cryptoKey = await crypto.subtle.importKey('raw', keyData, 'AES-CBC', false, ['decrypt']);
    cryptoKeyCache.set(keyUrl, cryptoKey);
  }));

  /**
   * セグメントをダウンロード・復号する
   * @param {number} i
   * @returns {Promise<ArrayBuffer>}
   */
  async function fetchSegment(i) {
    const seg = segments[i];
    let data = await fetchArrayBuffer(seg.url);

    if (seg.keyUrl) {
      const cryptoKey = cryptoKeyCache.get(seg.keyUrl);
      const iv = seg.iv || generateSequenceIV(i);
      // キャッシュ済み CryptoKey を使って直接復号（importKey 不要）
      data = await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, cryptoKey, data);
    }

    return data;
  }

  /** @type {Map<number, Promise<ArrayBuffer>>} */
  const prefetchBuffer = new Map();

  // 初期プリフェッチ
  for (let i = 0; i < Math.min(segments.length, concurrency); i++) {
    prefetchBuffer.set(i, fetchSegment(i));
  }

  for (let i = 0; i < segments.length; i++) {
    const data = await prefetchBuffer.get(i);
    prefetchBuffer.delete(i);

    // 次のセグメントをプリフェッチ開始
    const nextIdx = i + concurrency;
    if (nextIdx < segments.length) {
      prefetchBuffer.set(nextIdx, fetchSegment(nextIdx));
    }

    await onSegment(data, i + 1, segments.length);
  }
}

/**
 * 全セグメントを最大並列数で一括ダウンロード（500MB メモリ許容時の高速化）
 * 全セグメントを同時にフェッチし始めることで、CDN のスループットを最大活用する
 * @param {string | null} initSegmentUrl
 * @param {HlsSegment[]} segments
 * @param {{ initData?: ArrayBuffer, concurrency?: number }} [options]
 * @returns {Promise<Array<{data: ArrayBuffer, index: number}>>}
 */
export async function fetchAllSegmentsParallel(initSegmentUrl, segments, options = {}) {
  const concurrency = options.concurrency || 64;

  // init segment
  let initData = options.initData || null;
  if (!initData && initSegmentUrl) {
    initData = await fetchArrayBuffer(initSegmentUrl);
  }

  // 暗号化キーを事前フェッチ + インポート
  /** @type {Map<string, CryptoKey>} */
  const cryptoKeyCache = new Map();
  const uniqueKeyUrls = [...new Set(segments.map(s => s.keyUrl).filter(Boolean))];
  await Promise.all(uniqueKeyUrls.map(async (keyUrl) => {
    const keyData = await fetchArrayBuffer(keyUrl);
    const cryptoKey = await crypto.subtle.importKey('raw', keyData, 'AES-CBC', false, ['decrypt']);
    cryptoKeyCache.set(keyUrl, cryptoKey);
  }));

  // セマフォで最大並列数を制限しつつ全セグメントを一括ダウンロード
  let active = 0;
  let next = 0;
  /** @type {Array<{data: ArrayBuffer, index: number}>} */
  const results = [];
  if (initData) results.push({ data: initData, index: 0 });

  await new Promise((resolve, reject) => {
    function dispatch() {
      while (active < concurrency && next < segments.length) {
        const i = next++;
        active++;
        const seg = segments[i];
        (async () => {
          let data = await fetchArrayBuffer(seg.url);
          if (seg.keyUrl) {
            const key = cryptoKeyCache.get(seg.keyUrl);
            const iv = seg.iv || generateSequenceIV(i);
            data = await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, key, data);
          }
          return { data, index: i + 1 };
        })().then(result => {
          results.push(result);
          active--;
          if (next < segments.length) {
            dispatch();
          } else if (active === 0) {
            resolve();
          }
        }).catch(reject);
      }
      if (next >= segments.length && active === 0) resolve();
    }
    dispatch();
  });

  // index 順にソート（並列ダウンロードで順番が変わるため）
  results.sort((a, b) => a.index - b.index);
  return results;
}

/**
 * セグメントを順次ダウンロード・復号して結合（非ストリーミング版、メモリを消費する）
 * @param {string | null} initSegmentUrl
 * @param {HlsSegment[]} segments
 * @param {(progress: number, total: number) => void} [onProgress]
 * @returns {Promise<ArrayBuffer>}
 */
export async function fetchAndDecryptSegments(initSegmentUrl, segments, onProgress) {
  /** @type {ArrayBuffer[]} */
  const buffers = [];

  await forEachSegment(initSegmentUrl, segments, async (data, current, total) => {
    buffers.push(data);
    if (onProgress && current > 0) {
      onProgress(current, total);
    }
  });

  return concatBuffers(buffers);
}

/**
 * AES-128-CBC 復号（単発用。forEachSegment 内では CryptoKey キャッシュを使用）
 * @param {ArrayBuffer} encryptedData
 * @param {ArrayBuffer} keyData
 * @param {Uint8Array} iv
 * @returns {Promise<ArrayBuffer>}
 */
export async function decryptSegment(encryptedData, keyData, iv) {
  const key = await crypto.subtle.importKey('raw', keyData, 'AES-CBC', false, ['decrypt']);
  return await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, key, encryptedData);
}

/**
 * IV 文字列を Uint8Array にパース
 * @param {string} ivStr - "0x..." 形式
 * @returns {Uint8Array}
 */
export function parseIV(ivStr) {
  const hex = ivStr.startsWith('0x') ? ivStr.substring(2) : ivStr;
  const padded = hex.padStart(32, '0');
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    bytes[i] = parseInt(padded.substring(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/**
 * シーケンス番号から IV を生成
 * @param {number} sequenceNumber
 * @returns {Uint8Array}
 */
function generateSequenceIV(sequenceNumber) {
  const iv = new Uint8Array(16);
  const view = new DataView(iv.buffer);
  view.setUint32(12, sequenceNumber);
  return iv;
}

/**
 * m3u8 属性をパース
 * @param {string} attrString
 * @returns {Record<string, string>}
 */
export function parseAttributes(attrString) {
  /** @type {Record<string, string>} */
  const attrs = {};
  // 属性：KEY=VALUE or KEY="VALUE"
  const regex = /([A-Z0-9-]+)=(?:"([^"]*)"|([^,]*))/g;
  let match;
  while ((match = regex.exec(attrString)) !== null) {
    attrs[match[1]] = match[2] !== undefined ? match[2] : match[3];
  }
  return attrs;
}

/**
 * @param {string} url
 * @returns {Promise<string>}
 */
async function fetchText(url) {
  const resp = await fetch(url, { 
    credentials: 'include',
    keepalive: true, // コネクション維持
  });
  if (!resp.ok) throw new Error(`Fetch failed: ${resp.status} ${url}`);
  return resp.text();
}

/**
 * @param {string} url
 * @returns {Promise<ArrayBuffer>}
 */
async function fetchArrayBuffer(url) {
  const resp = await fetch(url, { 
    credentials: 'include',
    keepalive: true, // コネクション維持
  });
  if (!resp.ok) throw new Error(`Fetch failed: ${resp.status} ${url}`);
  return resp.arrayBuffer();
}

/**
 * 相対 URL を解決
 * @param {string} url
 * @param {string} baseUrl
 * @returns {string}
 */
function resolveUrl(url, baseUrl) {
  if (!url) return '';
  if (url.startsWith('http://') || url.startsWith('https://')) return url;
  return new URL(url, baseUrl).href;
}

/**
 * ArrayBuffer を結合
 * @param {ArrayBuffer[]} buffers
 * @returns {ArrayBuffer}
 */
function concatBuffers(buffers) {
  const totalLength = buffers.reduce((sum, buf) => sum + buf.byteLength, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const buf of buffers) {
    result.set(new Uint8Array(buf), offset);
    offset += buf.byteLength;
  }
  return result.buffer;
}
