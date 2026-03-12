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
 * @param {number} tabId
 * @param {string} url
 * @param {object} init
 */
async function fetchViaTab(tabId, url, init) {
  const result = await chrome.tabs.sendMessage(tabId, {
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
    let lastVideoTimestamp = -1;
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

    const { muxer, target } = await createMuxer({
      videoWidth: width,
      videoHeight: height,
      videoCodec,
      audioSampleRate,
      audioChannels,
      audioDescription,
    });

    const autoBitrate = width >= 1920 ? 4_000_000
      : width >= 1280 ? 2_500_000
      : width >= 854 ? 1_800_000
      : width >= 640 ? 1_200_000
      : 800_000;

    const compositor = new Compositor({
      width,
      height,
      bitrate: autoBitrate,
      onEncodedChunk: (chunk, meta) => {
        let timestamp = chunk.timestamp;
        if (timestamp <= lastVideoTimestamp) timestamp = lastVideoTimestamp + 1;
        lastVideoTimestamp = timestamp;

        const dataBuffer = new Uint8Array(chunk.byteLength);
        chunk.copyTo(dataBuffer);
        muxer.addVideoChunk(new EncodedVideoChunk({
          // @ts-ignore
          type: chunk.type,
          timestamp,
          duration: chunk.duration || 0,
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

    const videoDecoder = new VideoDecoder({
      output: (frame) => {
        if (globalStartTimestamp === null) {
          globalStartTimestamp = frame.timestamp;
          compositor.setTimestampOffset(globalStartTimestamp);
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
      error: (e) => console.error('[VideoDecoder] Error:', e),
    });

    const decoderConfig = videoCodecConfig || { codec: 'avc1.64001f' };
    // @ts-ignore
    videoDecoder.configure(decoderConfig);

    await forEachSegment(
      videoPlaylist.initSegmentUrl,
      videoPlaylist.segments,
      async (data, segIndex, total) => {
        if (segIndex === 0) return;
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
          while (videoDecoder.decodeQueueSize > 8) {
            await new Promise(resolve => videoDecoder.addEventListener('dequeue', resolve, { once: true }));
          }
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
      },
      { initData: videoInitData, concurrency: 4 },
    );

    await videoDecoder.flush();
    videoDecoder.close();
    await Promise.all(framePromises);
    await compositor.flush();

    if (audioPlaylist) {
      updateProgress({ stage: 'muxing', message: '音声を結合中...', current: 0, total: audioPlaylist.segments.length, percent: 90 });
      await forEachSegment(
        audioPlaylist.initSegmentUrl,
        audioPlaylist.segments,
        async (data, segIndex) => {
          if (segIndex === 0) return;
          const audioChunks = extractVideoChunks(data, { timescale: audioTimescale });
          for (const chunk of audioChunks) {
            if (!chunk.data || chunk.data.byteLength === 0) continue;
            if (globalStartTimestamp === null) globalStartTimestamp = chunk.timestamp;
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
        { initData: audioInitData, concurrency: 4 },
      );
    }

    updateProgress({ stage: 'muxing', message: 'ファイルを生成中...', current: 0, total: 1, percent: 95 });

    const mp4Buffer = finalizeMuxer(muxer, target);
    const blob = new Blob([mp4Buffer], { type: 'video/mp4' });
    const blobUrl = URL.createObjectURL(blob);
    const filename = sanitizeFilename(`${videoInfo.title} [${videoInfo.videoId}].mp4`);

    await chrome.downloads.download({ url: blobUrl, filename, saveAs: true });

    updateProgress({ stage: 'complete', message: 'ダウンロード完了!', current: 1, total: 1, percent: 100 });
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
