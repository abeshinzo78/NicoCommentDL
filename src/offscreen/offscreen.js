// @ts-check
// Chrome MV3 Offscreen Document
// Service Worker では使えない WebCodecs / OffscreenCanvas / Canvas2D を
// 通常の HTML ページコンテキストで実行するためのエントリポイント

import { fetchHlsUrl, fetchComments, buildOutputs, getAuthorizedQualities } from '../background/api/niconico.js';
import { parseMasterPlaylist, parseMediaPlaylist, fetchAndDecryptSegments, forEachSegment } from '../background/api/hls-fetcher.js';
import { Compositor } from '../background/video/compositor.js';
import { extractVideoChunks, extractAudioConfig, extractH264Config, extractTimescale } from '../background/video/decoder.js';
import { createMuxer, finalizeMuxer } from '../background/muxer/mp4-muxer-wrapper.js';
import { isH264Supported } from '../background/video/encoder.js';
import { sanitizeFilename } from '../shared/utils.js';

/** @type {import('../shared/messages.js').ProgressInfo | null} */
let currentProgress = null;

/**
 * AVCC形式のサンプルデータからSPS/PPSを抽出する
 * @param {Uint8Array} data
 * @returns {{ sps: Uint8Array | null, pps: Uint8Array | null }}
 */
function extractSPSPPS(data) {
  let offset = 0;
  let sps = null;
  let pps = null;
  while (offset + 4 <= data.length) {
    const naluLen = (data[offset] << 24 | data[offset+1] << 16 | data[offset+2] << 8 | data[offset+3]) >>> 0;
    if (naluLen === 0 || offset + 4 + naluLen > data.length) break;
    const naluType = data[offset + 4] & 0x1f;
    if (naluType === 7) sps = data.slice(offset + 4, offset + 4 + naluLen);
    if (naluType === 8) pps = data.slice(offset + 4, offset + 4 + naluLen);
    offset += 4 + naluLen;
  }
  return { sps, pps };
}

/**
 * SPS/PPSから正しいAVCDecoderConfigurationRecordを構築する
 * @param {Uint8Array} sps
 * @param {Uint8Array} pps
 * @returns {ArrayBuffer}
 */
function buildAVCDescription(sps, pps) {
  const profileIdc    = sps[1];
  const profileCompat = sps[2];
  const levelIdc      = sps[3];
  const out = new Uint8Array(7 + 2 + sps.length + 1 + 2 + pps.length);
  let i = 0;
  out[i++] = 0x01; out[i++] = profileIdc; out[i++] = profileCompat; out[i++] = levelIdc;
  out[i++] = 0xff; out[i++] = 0xe1;
  out[i++] = (sps.length >> 8) & 0xff; out[i++] = sps.length & 0xff;
  out.set(sps, i); i += sps.length;
  out[i++] = 0x01;
  out[i++] = (pps.length >> 8) & 0xff; out[i++] = pps.length & 0xff;
  out.set(pps, i);
  return out.buffer;
}

/**
 * 進捗状態を更新して SW 経由で popup に通知
 * @param {import('../shared/messages.js').ProgressInfo} progress
 */
function updateProgress(progress) {
  currentProgress = progress;
  chrome.runtime.sendMessage({
    type: 'DOWNLOAD_PROGRESS',
    data: progress,
  }).catch(() => {});
}

/**
 * content script 経由で cookie 付き fetch を実行
 * offscreen document は chrome.tabs にアクセスできないため SW 経由でリレーする
 * @param {number} tabId
 * @param {string} url
 * @param {object} init
 */
async function fetchViaTab(tabId, url, init) {
  const result = await chrome.runtime.sendMessage({
    type: 'PROXY_FETCH',
    tabId,
    url,
    init,
  });

  if (!result) {
    throw new Error('PROXY_FETCH: content script から応答がありませんでした');
  }
  if (!result.ok) {
    return {
      ok: false,
      status: result.status,
      statusText: result.error || '',
      json: () => Promise.resolve(result.data),
    };
  }
  return {
    ok: true,
    status: result.status,
    statusText: 'OK',
    json: () => Promise.resolve(result.data),
  };
}

/**
 * @param {string} [resStr]
 * @returns {{ width: number, height: number }}
 */
function parseResolution(resStr) {
  if (!resStr) return { width: 0, height: 0 };
  const parts = resStr.split('x');
  return {
    width: parseInt(parts[0], 10) || 0,
    height: parseInt(parts[1], 10) || 0,
  };
}

/**
 * メインのダウンロード処理（main.js と同じロジック、chrome.* を直接使用）
 * @param {any} watchData
 * @param {string} [preferredQuality]
 * @param {number} [tabId]
 */
async function startDownload(watchData, preferredQuality, tabId) {
  const { videoInfo, hlsInfo, commentInfo } = watchData;

  try {
    updateProgress({ stage: 'comments', message: 'コメントを取得中...', current: 0, total: 1, percent: 0 });

    let commentData = null;
    if (commentInfo.nvComment) {
      commentData = await fetchComments(commentInfo.nvComment);
    }

    updateProgress({ stage: 'hls', message: 'HLS URL を取得中...', current: 0, total: 1, percent: 5 });

    const authorized = getAuthorizedQualities(hlsInfo.accessRightKey);
    let videos, audios;
    if (authorized && authorized.videos.length > 0 && authorized.audios.length > 0) {
      videos = authorized.videos.map(id => ({ id, isAvailable: true }));
      audios = authorized.audios.map(id => ({ id, isAvailable: true }));
    } else {
      videos = hlsInfo.videos;
      audios = hlsInfo.audios;
    }

    const outputs = buildOutputs(videos, audios, preferredQuality);
    const fetchFn = tabId ? (url, init) => fetchViaTab(tabId, url, init) : undefined;
    const hlsData = await fetchHlsUrl(videoInfo.videoId, hlsInfo.accessRightKey, outputs[0], { fetchFn });

    updateProgress({ stage: 'hls', message: '動画情報を解析中...', current: 0, total: 1, percent: 10 });

    const { variants, audioUrl } = await parseMasterPlaylist(hlsData.contentUrl);
    if (variants.length === 0) throw new Error('No video variants found in master playlist');

    let selectedVariant = variants[0];
    if (preferredQuality) {
      const match = variants.find(v => v.url.includes(preferredQuality) || (v.resolution && v.resolution.includes(preferredQuality)));
      if (match) selectedVariant = match;
    }

    const videoPlaylist = await parseMediaPlaylist(selectedVariant.url);
    const audioPlaylist = audioUrl ? await parseMediaPlaylist(audioUrl) : null;

    const h264Supported = await isH264Supported();
    const videoCodec = h264Supported ? 'avc' : 'vp9';

    const resolution = parseResolution(selectedVariant.resolution);
    let lastAudioTimestamp = -1;
    /** @type {number | null} */
    let globalStartTimestamp = null;
    const width = resolution.width || 640;
    const height = resolution.height || 360;

    let audioSampleRate = 48000;
    let audioChannels = 2;
    let audioDescription = undefined;
    let audioInitData = null;
    let videoInitData = null;
    let videoCodecConfig = null;
    let videoTimescale = 90000;
    let audioTimescale = 48000;

    await Promise.all([
      videoPlaylist.initSegmentUrl ? (async () => {
        videoInitData = await fetchAndDecryptSegments(videoPlaylist.initSegmentUrl, [], () => {});
        const h264Config = extractH264Config(videoInitData);
        if (h264Config) {
          videoCodecConfig = {
            codec: h264Config.codec,
            codedWidth: h264Config.codedWidth,
            codedHeight: h264Config.codedHeight,
            description: h264Config.description,
          };
        }
        const ts = extractTimescale(videoInitData);
        if (ts) videoTimescale = ts;
      })() : Promise.resolve(),
      (audioPlaylist && audioPlaylist.initSegmentUrl) ? (async () => {
        audioInitData = await fetchAndDecryptSegments(audioPlaylist.initSegmentUrl, [], () => {});
        const audioConfig = extractAudioConfig(audioInitData);
        if (audioConfig) {
          audioSampleRate = audioConfig.audioSampleRate;
          audioChannels = audioConfig.audioChannels;
          audioDescription = audioConfig.audioDescription;
        }
        const ts = extractTimescale(audioInitData);
        if (ts) audioTimescale = ts;
      })() : Promise.resolve(),
    ]);

    const framerate = selectedVariant.frameRate || 30;

    const { muxer, target } = await createMuxer({
      videoWidth: width,
      videoHeight: height,
      videoCodec,
      videoFrameRate: Math.round(framerate), // CFR タイムスケール固定（mp4-muxerのデフォルト57600を回避）
      audioSampleRate,
      audioChannels,
      audioDescription,
    });

    // ビットレート: 高品質再エンコード用（メモリには影響しない — チャンクは即座に muxer へ渡る）
    // 解像度ベース × フレームレートスケール（30fps基準、最大1.5倍）
    const framerateScale = Math.min(framerate / 30, 1.5);
    const autoBitrate = Math.round((
      width >= 1920 ? 16_000_000
      : width >= 1280 ? 7_500_000
      : width >= 854 ? 4_500_000
      : width >= 640 ? 3_000_000
      : 1_200_000
    ) * framerateScale);

    // CFR 出力用カウンター（chunk.timestamp/duration は VFR になる場合があるため使わない）
    let videoFrameIdx = 0;
    const cfrDurationUs = Math.round(1_000_000 / framerate);

    const compositor = new Compositor({
      width,
      height,
      framerate,
      bitrate: autoBitrate,
      onEncodedChunk: (chunk, meta) => {
        // エンコーダー出力のタイムスタンプは使わず、フレームインデックスから CFR で計算
        const timestamp = videoFrameIdx * cfrDurationUs;
        videoFrameIdx++;

        const dataBuffer = new Uint8Array(chunk.byteLength);
        chunk.copyTo(dataBuffer);

        if (meta?.decoderConfig?.description && chunk.type === 'key') {
          const { sps, pps } = extractSPSPPS(dataBuffer);
          if (sps && pps && sps.length >= 4) {
            const correctDescription = buildAVCDescription(sps, pps);
            meta = { ...meta, decoderConfig: { ...meta.decoderConfig, description: correctDescription } };
          }
        }

        muxer.addVideoChunk(new EncodedVideoChunk({
          // @ts-ignore
          type: chunk.type,
          timestamp,
          duration: cfrDurationUs,
          data: dataBuffer,
        }), meta);
      },
      onProgress: (current, total) => {
        updateProgress({
          stage: 'encoding',
          message: `コメント合成中... (フレーム ${current}/${total})`,
          current,
          total,
          percent: 55 + Math.round((current / total) * 35),
        });
      },
    });

    if (commentData) compositor.setComments(commentData);
    await compositor.init();

    /** @type {Promise<void>[]} */
    const framePromises = [];
    let pendingFrameCount = 0;
    /** @type {(() => void) | null} */
    let resolveFrameSlot = null;
    const MAX_PENDING_FRAMES = 8;

    // globalStartTimestamp 確定通知（音声の並列処理用）
    /** @type {(() => void) | null} */
    let resolveTimestampReady = null;
    const timestampReadyPromise = new Promise(r => { resolveTimestampReady = r; });

    // avcC description から SPS/PPS NALU を抽出（Annex B フォールバック用）
    let spsNalu = null;
    let ppsNalu = null;
    if (videoCodecConfig?.description) {
      const desc = videoCodecConfig.description instanceof Uint8Array
        ? videoCodecConfig.description
        : new Uint8Array(videoCodecConfig.description);
      // AVCDecoderConfigurationRecord: [01][profile][compat][level][ff][e1][sps_len_hi][sps_len_lo][sps...][01][pps_len_hi][pps_len_lo][pps...]
      if (desc.length >= 8 && desc[0] === 0x01) {
        let pos = 6; // skip configurationVersion(1)+profile(1)+compat(1)+level(1)+ff(1)+e1(1)
        if (pos + 2 <= desc.length) {
          const spsLen = (desc[pos] << 8) | desc[pos + 1]; pos += 2;
          if (pos + spsLen <= desc.length) {
            spsNalu = desc.slice(pos, pos + spsLen); pos += spsLen;
            if (pos < desc.length) {
              pos++; // numPPS = 1
              if (pos + 2 <= desc.length) {
                const ppsLen = (desc[pos] << 8) | desc[pos + 1]; pos += 2;
                if (pos + ppsLen <= desc.length) ppsNalu = desc.slice(pos, pos + ppsLen);
              }
            }
          }
        }
      }
      console.log('[offscreen] SPS/PPS from avcC:', spsNalu?.length, ppsNalu?.length);
    }

    /**
     * AVCC 形式のチャンクから SPS/PPS NALU (type 7/8) を除去する
     * description ありモード：デコーダはすでに description 経由で SPS/PPS を持っているため
     * チャンク内の重複 SPS/PPS は EncodingError の原因となる
     * @param {ArrayBuffer} data
     * @returns {ArrayBuffer}
     */
    function stripSPSPPSFromAVCC(data) {
      const bytes = new Uint8Array(data);
      /** @type {Array<{start: number, len: number}>} */
      const keep = [];
      let strippedCount = 0;
      let offset = 0;
      while (offset + 4 <= bytes.length) {
        const len = (bytes[offset] << 24 | bytes[offset+1] << 16 | bytes[offset+2] << 8 | bytes[offset+3]) >>> 0;
        if (len === 0 || offset + 4 + len > bytes.length) break;
        const naluType = bytes[offset + 4] & 0x1f;
        if (naluType === 7 || naluType === 8) {
          strippedCount++;
        } else {
          keep.push({ start: offset, len: 4 + len });
        }
        offset += 4 + len;
      }
      // SPS/PPS が見つからなかった場合はそのまま返す（変更不要）
      if (strippedCount === 0) return data;
      // 全 NALU が SPS/PPS の場合もそのまま返す（安全のため）
      if (keep.length === 0) return data;
      console.log(`[offscreen] Stripped ${strippedCount} SPS/PPS NALUs from chunk`);
      const total = keep.reduce((s, k) => s + k.len, 0);
      const out = new Uint8Array(total);
      let p = 0;
      for (const k of keep) { out.set(bytes.subarray(k.start, k.start + k.len), p); p += k.len; }
      return out.buffer;
    }

    /**
     * AVCC 形式のチャンクを Annex B 形式に変換
     * description なしモード用：スタートコードに変換し、キーフレームには SPS/PPS を先頭に付加
     * @param {ArrayBuffer} data
     * @param {boolean} isKeyframe
     * @returns {ArrayBuffer}
     */
    function avccToAnnexB(data, isKeyframe) {
      const bytes = new Uint8Array(data);
      const startCode = new Uint8Array([0, 0, 0, 1]);
      /** @type {Uint8Array[]} */
      const parts = [];
      if (isKeyframe && spsNalu && ppsNalu) {
        parts.push(startCode, spsNalu, startCode, ppsNalu);
      }
      let offset = 0;
      while (offset + 4 <= bytes.length) {
        const len = (bytes[offset] << 24 | bytes[offset+1] << 16 | bytes[offset+2] << 8 | bytes[offset+3]) >>> 0;
        if (len === 0 || offset + 4 + len > bytes.length) break;
        parts.push(startCode, bytes.slice(offset + 4, offset + 4 + len));
        offset += 4 + len;
      }
      if (parts.length === 0) return data;
      const total = parts.reduce((s, p) => s + p.length, 0);
      const out = new Uint8Array(total);
      let p = 0;
      for (const part of parts) { out.set(part, p); p += part.length; }
      return out.buffer;
    }

    // Chrome の VideoDecoder: AVC H.264 は description あり（AVCC モード）を使用する。
    // Chrome は "fill out the description field" と明示的に要求する。
    // fMP4 CMAF セグメントは AVCC 形式（4バイト長プレフィックス）のため、description モードが適合。
    // キーフレームに in-band SPS/PPS NALU (type 7/8) が含まれている場合は除去する
    // （description で渡済みのため、重複すると EncodingError になる）。
    //
    // NOTE: Offscreen Document では GPU プロセスへのアクセスが制限される場合があり、
    // ハードウェアデコーダーが失敗することがある。prefer-software で安定性を向上させる。

    // description を明示的に ArrayBuffer に変換（Uint8Array だと Chrome の内部処理で問題が出る場合がある）
    let descriptionBuffer = null;
    if (videoCodecConfig?.description) {
      const d = videoCodecConfig.description;
      if (d instanceof ArrayBuffer) {
        descriptionBuffer = d;
      } else {
        // Uint8Array の場合、byteOffset を考慮して正確なスライスを取得
        descriptionBuffer = d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength);
      }
      // 診断ログ: description の先頭バイトを hex で出力
      const dbytes = new Uint8Array(descriptionBuffer);
      console.log('[offscreen] description hex (first 16):', Array.from(dbytes.slice(0, 16)).map(b => b.toString(16).padStart(2, '0')).join(' '));
      console.log('[offscreen] description length:', dbytes.length, 'codec:', videoCodecConfig.codec);
    }

    let decoderConfig;
    let useAnnexB = false;
    if (videoCodecConfig && descriptionBuffer) {
      // AVCC+description を優先する（Chrome の推奨方式）
      // prefer-software で Offscreen Document での安定動作を優先する
      const fullConfig = {
        codec: videoCodecConfig.codec,
        codedWidth: videoCodecConfig.codedWidth,
        codedHeight: videoCodecConfig.codedHeight,
        description: descriptionBuffer,
        hardwareAcceleration: 'prefer-software',
      };
      const fullSupport = await VideoDecoder.isConfigSupported(fullConfig);
      console.log('[offscreen] isConfigSupported (AVCC+description prefer-software):', fullSupport.supported, videoCodecConfig.codec);
      if (fullSupport.supported) {
        decoderConfig = fullConfig;
        useAnnexB = false;
      } else {
        // prefer-hardware でリトライ
        const hwConfig = {
          codec: videoCodecConfig.codec,
          codedWidth: videoCodecConfig.codedWidth,
          codedHeight: videoCodecConfig.codedHeight,
          description: descriptionBuffer,
        };
        const hwSupport = await VideoDecoder.isConfigSupported(hwConfig);
        console.log('[offscreen] isConfigSupported (AVCC+description no-hint):', hwSupport.supported);
        decoderConfig = hwSupport.supported ? hwConfig : { codec: videoCodecConfig.codec, description: descriptionBuffer };
        useAnnexB = false;
      }
    } else if (videoCodecConfig) {
      // description なしフォールバック（Annex B モード）
      const annexBConfig = {
        codec: videoCodecConfig.codec,
        codedWidth: videoCodecConfig.codedWidth,
        codedHeight: videoCodecConfig.codedHeight,
        hardwareAcceleration: 'prefer-software',
      };
      const annexBSupport = await VideoDecoder.isConfigSupported(annexBConfig);
      console.log('[offscreen] isConfigSupported (Annex B, no description):', annexBSupport.supported);
      decoderConfig = annexBSupport.supported ? annexBConfig : { codec: videoCodecConfig.codec };
      useAnnexB = true;
    } else {
      decoderConfig = { codec: 'avc1.64001f', hardwareAcceleration: 'prefer-software' };
      useAnnexB = true;
    }

    /** @type {DOMException | null} */
    let decoderError = null;

    const videoDecoder = new VideoDecoder({
      output: (frame) => {
        if (globalStartTimestamp === null) {
          globalStartTimestamp = frame.timestamp;
          compositor.setTimestampOffset(globalStartTimestamp);
          if (resolveTimestampReady) {
            resolveTimestampReady();
            resolveTimestampReady = null;
          }
        }
        pendingFrameCount++;
        const p = compositor.processFrame(frame).finally(() => {
          pendingFrameCount--;
          if (resolveFrameSlot && pendingFrameCount < MAX_PENDING_FRAMES) {
            const r = resolveFrameSlot;
            resolveFrameSlot = null;
            r();
          }
        });
        framePromises.push(p);
      },
      error: (e) => {
        decoderError = e;
        console.error('[VideoDecoder] Error:', e.name, e.message, e.code, e);
        // デコードループをアンブロック（pendingFrameCount 待機中の場合）
        if (resolveFrameSlot) {
          const r = resolveFrameSlot;
          resolveFrameSlot = null;
          r();
        }
      },
    });

    // @ts-ignore
    videoDecoder.configure(decoderConfig);
    console.log('[offscreen] VideoDecoder configured:', decoderConfig.codec, useAnnexB ? '(Annex B mode)' : '(AVCC+description mode)', 'hw:', decoderConfig.hardwareAcceleration || 'default');

    let firstChunkLogged = false;

    // 音声処理を並列起動（globalStartTimestamp 確定後にダウンロード+muxer投入開始）
    const audioPromise = (audioPlaylist) ? (async () => {
      await timestampReadyPromise;

      await forEachSegment(
        audioPlaylist.initSegmentUrl,
        audioPlaylist.segments,
        async (data, segIndex) => {
          if (segIndex === 0) return;
          const audioChunks = extractVideoChunks(data, { timescale: audioTimescale });
          for (const chunk of audioChunks) {
            if (!chunk.data || chunk.data.byteLength === 0) continue;
            let normalizedTimestamp = chunk.timestamp - globalStartTimestamp;
            if (normalizedTimestamp <= lastAudioTimestamp) normalizedTimestamp = lastAudioTimestamp + 1;
            lastAudioTimestamp = normalizedTimestamp;
            muxer.addAudioChunk(new EncodedAudioChunk({
              type: 'key',
              timestamp: Math.max(0, normalizedTimestamp),
              duration: chunk.duration || 0,
              data: chunk.data,
            }));
          }
        },
        { initData: audioInitData, concurrency: 6 },
      );
    })() : Promise.resolve();

    await forEachSegment(
      videoPlaylist.initSegmentUrl,
      videoPlaylist.segments,
      async (data, segIndex, total) => {
        if (segIndex === 0) return;
        if (decoderError || videoDecoder.state === 'closed') return;
        updateProgress({
          stage: 'encoding',
          message: `コメント合成中... (セグメント ${segIndex}/${total})`,
          current: segIndex,
          total,
          percent: 15 + Math.round((segIndex / total) * 55),
        });
        const chunks = extractVideoChunks(data, { timescale: videoTimescale });
        for (const chunk of chunks) {
          if (!chunk.data || chunk.data.byteLength === 0) continue;
          if (decoderError || videoDecoder.state === 'closed') break;
          while (videoDecoder.decodeQueueSize > 16) {
            if (decoderError || videoDecoder.state === 'closed') break;
            await new Promise(resolve => videoDecoder.addEventListener('dequeue', resolve, { once: true }));
          }
          if (decoderError || videoDecoder.state === 'closed') break;
          if (pendingFrameCount >= MAX_PENDING_FRAMES) {
            await new Promise(resolve => { resolveFrameSlot = resolve; });
          }
          if (decoderError || videoDecoder.state === 'closed') break;
          const rawData = chunk.data instanceof ArrayBuffer ? chunk.data : chunk.data.buffer;
          const chunkData = useAnnexB
            ? avccToAnnexB(rawData, chunk.isKeyframe)
            : stripSPSPPSFromAVCC(rawData);
          if (!firstChunkLogged) {
            firstChunkLogged = true;
            const fb = new Uint8Array(chunkData instanceof ArrayBuffer ? chunkData : chunkData);
            console.log('[offscreen] First chunk:', chunk.isKeyframe ? 'KEY' : 'DELTA', 'size:', fb.byteLength, 'hex:', Array.from(fb.slice(0, 16)).map(b => b.toString(16).padStart(2, '0')).join(' '));
          }
          videoDecoder.decode(new EncodedVideoChunk({
            type: chunk.isKeyframe ? 'key' : 'delta',
            timestamp: chunk.timestamp,
            duration: chunk.duration,
            data: chunkData,
          }));
        }
      },
      { initData: videoInitData, concurrency: 6 },
    );

    if (decoderError) {
      throw new Error(`VideoDecoder error (${decoderError.name}): ${decoderError.message}`);
    }
    if (videoDecoder.state !== 'closed') {
      await videoDecoder.flush();
      videoDecoder.close();
    }
    await Promise.all(framePromises);
    await compositor.flush();

    // 音声処理の完了を待つ（動画と並列で進行済み）
    await audioPromise;

    updateProgress({ stage: 'muxing', message: 'ファイルを生成中...', current: 0, total: 1, percent: 95 });

    const mp4Buffer = finalizeMuxer(muxer, target);
    const blob = new Blob([mp4Buffer], { type: 'video/mp4' });
    const blobUrl = URL.createObjectURL(blob);
    const filename = sanitizeFilename(`${videoInfo.title} [${videoInfo.videoId}].mp4`);

    // chrome.downloads は Offscreen Document では使用不可のため SW に中継する
    await chrome.runtime.sendMessage({ type: 'TRIGGER_DOWNLOAD', url: blobUrl, filename });
    // ダウンロード開始後はブラウザが blob を保持するため revoke は短時間でよい
    setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);

    updateProgress({ stage: 'complete', message: 'ダウンロード完了!', current: 1, total: 1, percent: 100 });

  } catch (error) {
    console.error('[NicoCommentDL] Error in startDownload:', error);
    updateProgress({
      stage: 'error',
      message: `エラー：${error.message}`,
      current: 0,
      total: 0,
      percent: 0,
    });
  }
}

// Offscreen Document のメッセージリスナー
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  switch (message.type) {
    case 'OFFSCREEN_START_DOWNLOAD': {
      const { watchData, preferredQuality, tabId } = message.data;
      startDownload(watchData, preferredQuality, tabId);
      return false;
    }
    case 'OFFSCREEN_GET_STATUS':
      sendResponse({ progress: currentProgress });
      return false;
    default:
      return false;
  }
});
