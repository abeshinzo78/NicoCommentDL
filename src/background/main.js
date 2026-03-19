// @ts-check
import { fetchHlsUrl, fetchComments, buildOutputs, getAuthorizedQualities } from './api/niconico.js';
import { parseMasterPlaylist, parseMediaPlaylist, fetchAndDecryptSegments, forEachSegment } from './api/hls-fetcher.js';
import { Compositor } from './video/compositor.js';
import { decodeVideo, extractVideoChunks, extractAudioConfig, extractH264Config, extractTimescale } from './video/decoder.js';
import { createMuxer, finalizeMuxer } from './muxer/mp4-muxer-wrapper.js';
import { isH264Supported } from './video/encoder.js';
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
 * Firefox WebCodecsがdecoderConfig.descriptionに余分なバイトを付けるバグを回避
 * @param {Uint8Array} sps - NALユニットヘッダを含むSPSデータ
 * @param {Uint8Array} pps - NALユニットヘッダを含むPPSデータ
 * @returns {ArrayBuffer}
 */
function buildAVCDescription(sps, pps) {
  // SPS: [0x67(NAL header)][profile_idc][profile_compat][level_idc][...]
  const profileIdc   = sps[1];
  const profileCompat = sps[2];
  const levelIdc     = sps[3];
  const out = new Uint8Array(7 + 2 + sps.length + 1 + 2 + pps.length);
  let i = 0;
  out[i++] = 0x01;                     // configurationVersion
  out[i++] = profileIdc;               // AVCProfileIndication
  out[i++] = profileCompat;            // profile_compatibility
  out[i++] = levelIdc;                 // AVCLevelIndication
  out[i++] = 0xff;                     // reserved(6) | lengthSizeMinusOne(3) = 4byte長
  out[i++] = 0xe1;                     // reserved(3) | numSPS = 1
  out[i++] = (sps.length >> 8) & 0xff;
  out[i++] = sps.length & 0xff;
  out.set(sps, i); i += sps.length;
  out[i++] = 0x01;                     // numPPS = 1
  out[i++] = (pps.length >> 8) & 0xff;
  out[i++] = pps.length & 0xff;
  out.set(pps, i);
  return out.buffer;
}

/** @type {Map<number, any>} */
const tabData = new Map();

/**
 * 進捗状態を更新して全 popup に通知
 * @param {import('../shared/messages.js').ProgressInfo} progress
 */
function updateProgress(progress) {
  currentProgress = progress;
  browser.runtime.sendMessage({
    type: 'DOWNLOAD_PROGRESS',
    data: progress,
  }).catch(() => { /* popup 閉じている場合 */ });
}

/**
 * Content script のページコンテキスト（cookie 付き）を経由して fetch を代理実行する
 * Background script からの fetch は cookie が送られないケースがあるため、
 * ニコニコ API へのリクエストはすべてこの関数経由で行う。
 * @param {number} tabId
 * @param {string} url
 * @param {object} init
 * @returns {Promise<any>}
 */
async function fetchViaTab(tabId, url, init) {
  const result = await browser.tabs.sendMessage(tabId, {
    type: 'PROXY_FETCH',
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
 * メインのダウンロード処理
 * @param {any} watchData
 * @param {string} [preferredQuality]
 * @param {number} [tabId]
 */
async function startDownload(watchData, preferredQuality, tabId) {
  const { videoInfo, hlsInfo, commentInfo } = watchData;

  try {
    // 1. コメント取得
    updateProgress({
      stage: 'comments',
      message: 'コメントを取得中...',
      current: 0,
      total: 1,
      percent: 0,
    });

    let commentData = null;
    if (commentInfo.nvComment) {
      commentData = await fetchComments(commentInfo.nvComment);
    }

    // 2. HLS URL 取得
    updateProgress({
      stage: 'hls',
      message: 'HLS URL を取得中...',
      current: 0,
      total: 1,
      percent: 5,
    });

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

    // 3. マスター playlist 解析
    updateProgress({
      stage: 'hls',
      message: '動画情報を解析中...',
      current: 0,
      total: 1,
      percent: 10,
    });

    const { variants, audioUrl } = await parseMasterPlaylist(hlsData.contentUrl);
    if (variants.length === 0) {
      throw new Error('No video variants found in master playlist');
    }

    let selectedVariant = variants[0];
    if (preferredQuality) {
      const match = variants.find(v => v.url.includes(preferredQuality) || (v.resolution && v.resolution.includes(preferredQuality)));
      if (match) selectedVariant = match;
    }
    const videoPlaylistUrl = selectedVariant.url;

    // 4. メディア playlist 解析
    const videoPlaylist = await parseMediaPlaylist(videoPlaylistUrl);

    let audioPlaylist = null;
    if (audioUrl) {
      audioPlaylist = await parseMediaPlaylist(audioUrl);
    }

    // 5. Muxer 準備
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

    // init segment を並列取得してメタデータを一括抽出
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
        console.log(`[NicoCommentDL] Audio metadata: ${audioSampleRate}Hz, ${audioChannels}ch, Description: ${!!audioDescription}`);
      })() : Promise.resolve(),
    ]);

    // フレームレート取得（master playlist の FRAME-RATE 属性 → なければ 30fps）
    const framerate = selectedVariant.frameRate || 30;
    console.log(`[main] Target framerate: ${framerate}fps (CFR)`);

    const { muxer, target } = await createMuxer({
      videoWidth: width,
      videoHeight: height,
      videoCodec,
      videoFrameRate: Math.round(framerate),
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

    // CFR 用フレームカウンタ：エンコーダ出力の timestamp/duration を無視し、
    // フレーム番号から均一なタイミングを算出して muxer に渡す
    let videoFrameIdx = 0;
    const cfrDurationUs = Math.round(1_000_000 / framerate);

    const compositor = new Compositor({
      width,
      height,
      framerate,
      bitrate: autoBitrate,
      onEncodedChunk: (chunk, meta) => {
        // CFR タイムスタンプ：フレーム番号 × 固定間隔（エンコーダ出力を無視）
        const timestamp = videoFrameIdx * cfrDurationUs;
        videoFrameIdx++;

        const dataBuffer = new Uint8Array(chunk.byteLength);
        chunk.copyTo(dataBuffer);

        // Firefox WebCodecsのバグ：decoderConfig.descriptionのSPS/PPSに余分なバイトが付く。
        // 実際のサンプルデータは正しいので、そこからSPS/PPSを抽出して正しいdescriptionを再構築する。
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
          data: dataBuffer
        }), meta);
      },
      onProgress: (current, total) => {
        const percent = 55 + Math.round((current / total) * 35);
        updateProgress({
          stage: 'encoding',
          message: `コメント合成中... (フレーム ${current}/${total})`,
          current,
          total,
          percent,
        });
      },
    });

    if (commentData) {
      compositor.setComments(commentData);
    }

    await compositor.init();

    // 6. 動画 + 音声をストリーミング処理
    //    動画: prefetch 6、全量一括 DL しない（メモリ節約）
    //    音声: 動画エンコードと並列にダウンロード・muxer 投入（時間短縮）

    /** @type {Promise<void>[]} */
    const framePromises = [];

    // コンポジターの未処理フレーム数を追跡し、溜まりすぎたらデコーダー入力を止める
    let pendingFrameCount = 0;
    /** @type {(() => void) | null} */
    let resolveFrameSlot = null;
    const MAX_PENDING_FRAMES = 8;

    // globalStartTimestamp が確定したら resolve する Promise（音声処理の開始トリガー）
    /** @type {(() => void) | null} */
    let resolveTimestampReady = null;
    const timestampReadyPromise = new Promise(r => { resolveTimestampReady = r; });

    const videoDecoder = new VideoDecoder({
      output: (frame) => {
        if (globalStartTimestamp === null) {
          globalStartTimestamp = frame.timestamp;
          compositor.setTimestampOffset(globalStartTimestamp);
          // 音声処理を開始させる
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
        console.error('[VideoDecoder] Error:', e);
      },
    });

    const decoderConfig = videoCodecConfig || { codec: 'avc1.64001f' };
    // @ts-ignore
    videoDecoder.configure(decoderConfig);
    console.log('[main] VideoDecoder configured:', decoderConfig.codec);

    // 音声処理を並列起動（globalStartTimestamp 確定後に muxer 投入開始）
    const audioPromise = (audioPlaylist) ? (async () => {
      // 動画の最初のフレームでタイムスタンプ基準が決まるのを待つ
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

            if (normalizedTimestamp <= lastAudioTimestamp) {
              normalizedTimestamp = lastAudioTimestamp + 1;
            }
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

    // 動画セグメントをストリーミング処理
    await forEachSegment(
      videoPlaylist.initSegmentUrl,
      videoPlaylist.segments,
      async (data, segIndex, total) => {
        if (segIndex === 0) return; // init segment はスキップ

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

          // デコーダーキューが溜まっていたら待機
          while (videoDecoder.decodeQueueSize > 16) {
            await new Promise(resolve => videoDecoder.addEventListener('dequeue', resolve, { once: true }));
          }
          // コンポジターの未処理フレームが多すぎたら待機（メモリ抑制）
          if (pendingFrameCount >= MAX_PENDING_FRAMES) {
            await new Promise(resolve => { resolveFrameSlot = resolve; });
          }

          videoDecoder.decode(new EncodedVideoChunk({
            type: chunk.isKeyframe ? 'key' : 'delta',
            timestamp: chunk.timestamp,
            duration: chunk.duration,
            data: chunk.data,
          }));
        }
        // data はここでスコープを抜けて GC 対象になる
      },
      { initData: videoInitData, concurrency: 6 },
    );

    await videoDecoder.flush();
    videoDecoder.close();
    await Promise.all(framePromises);
    await compositor.flush();

    // 音声処理の完了を待つ（動画と並列で進行済み）
    await audioPromise;

    // MP4 ファイナライズ
    updateProgress({
      stage: 'muxing',
      message: 'ファイルを生成中...',
      current: 0,
      total: 1,
      percent: 95,
    });

    const mp4Buffer = finalizeMuxer(muxer, target);

    // ダウンロード
    const blob = new Blob([mp4Buffer], { type: 'video/mp4' });
    const blobUrl = URL.createObjectURL(blob);
    const filename = sanitizeFilename(`${videoInfo.title} [${videoInfo.videoId}].mp4`);

    await browser.downloads.download({
      url: blobUrl,
      filename,
      saveAs: true,
    });

    updateProgress({
      stage: 'complete',
      message: 'ダウンロード完了!',
      current: 1,
      total: 1,
      percent: 100,
    });

    setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);

  } catch (error) {
    console.error('[NicoCommentDL] Error in startDownload:', error);
    updateProgress({
      stage: 'error',
      message: `エラー：${error.message}`,
      current: 0,
      total: 0,
      percent: 0,
    });
    throw error;
  }
}

/**
 * 解像度文字列をパース
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

// メッセージリスナー
browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const { type, data } = message;

  switch (type) {
    case 'WATCH_DATA_READY':
      if (sender.tab?.id) {
        tabData.set(sender.tab.id, data);
      }
      return false;

    case 'START_DOWNLOAD': {
      const tabId = data?.tabId;
      const watchData = tabData.get(tabId);
      if (!watchData) {
        browser.tabs.sendMessage(tabId, { type: 'EXTRACT_WATCH_DATA' }).then((wd) => {
          if (wd) {
            tabData.set(tabId, wd);
            startDownload(wd, data?.preferredQuality, tabId);
          } else {
            updateProgress({
              stage: 'error',
              message: 'ページからデータを取得できませんでした。ページを再読み込みしてから再試行してください。',
              current: 0,
              total: 0,
              percent: 0,
            });
          }
        });
      } else {
        startDownload(watchData, data?.preferredQuality, tabId);
      }
      return false;
    }

    case 'GET_STATUS':
      sendResponse({
        progress: currentProgress,
        tabData: sender.tab?.id ? tabData.get(sender.tab.id) : null,
      });
      return false;

    case 'GET_WATCH_DATA': {
      const tid = data?.tabId;
      if (tid && tabData.has(tid)) {
        sendResponse(tabData.get(tid));
      } else {
        sendResponse(null);
      }
      return false;
    }

    default:
      return false;
  }
});
