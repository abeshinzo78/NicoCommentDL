// @ts-check

/**
 * mp4-muxer ライブラリのラッパー
 * ビルド時にlib/mp4-muxer.jsからバンドルされる
 */

let MuxerModule = null;

/**
 * mp4-muxerモジュールをロード
 * @returns {Promise<any>}
 */
async function loadMuxer() {
  if (MuxerModule) return MuxerModule;
  // ビルド時にesbuildがバンドルする
  // @ts-ignore
  MuxerModule = await import('../../../lib/mp4-muxer.js');
  return MuxerModule;
}

/**
 * @typedef {object} MuxerOptions
 * @property {number} videoWidth
 * @property {number} videoHeight
 * @property {'avc' | 'vp9'} videoCodec
 * @property {number} [videoFrameRate] CFR 出力用フレームレート（正の整数）。指定するとタイムスケールがこの値になり完全CFRになる
 * @property {number} [audioSampleRate]
 * @property {number} [audioChannels]
 * @property {Uint8Array} [audioDescription]
 */

/**
 * MP4 Muxerを作成
 * @param {MuxerOptions} options
 * @returns {Promise<{ muxer: any, target: any }>}
 */
export async function createMuxer(options) {
  const { Muxer, ArrayBufferTarget } = await loadMuxer();

  const target = new ArrayBufferTarget();

  const videoConfig = {
    codec: options.videoCodec,
    width: options.videoWidth,
    height: options.videoHeight,
  };
  // frameRate を渡すとタイムスケールが frameRate になり、フレームデルタが常に 1 tick → 完全 CFR
  if (options.videoFrameRate && Number.isInteger(options.videoFrameRate) && options.videoFrameRate > 0) {
    // @ts-ignore
    videoConfig.frameRate = options.videoFrameRate;
  }

  const muxerConfig = {
    target,
    video: videoConfig,
    fastStart: 'in-memory',
  };

  if (options.audioSampleRate) {
    // @ts-ignore
    muxerConfig.audio = {
      codec: 'aac',
      numberOfChannels: options.audioChannels || 2,
      sampleRate: options.audioSampleRate,
      description: options.audioDescription,
    };
  }

  const muxer = new Muxer(muxerConfig);

  return { muxer, target };
}

/**
 * Muxerをファイナライズしてmp4データを返す
 * @param {any} muxer
 * @param {any} target
 * @returns {ArrayBuffer}
 */
export function finalizeMuxer(muxer, target) {
  muxer.finalize();
  return target.buffer;
}
