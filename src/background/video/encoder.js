// @ts-check

/**
 * VideoEncoder の設定を作成
 * Chrome/Edge 用：H.264 Baseline Profile
 * @param {number} width
 * @param {number} height
 * @param {number} [bitrate]
 * @param {number} [framerate]
 * @returns {VideoEncoderConfig}
 */
export function createEncoderConfig(width, height, bitrate = 5_000_000, framerate = 30) {
  return {
    codec: 'avc1.42001f', // H.264 Baseline Profile Level 3.1
    width,
    height,
    bitrate,
    framerate,
    hardwareAcceleration: 'prefer-hardware',
  };
}

/**
 * VP9 フォールバック用設定
 * @param {number} width
 * @param {number} height
 * @param {number} [bitrate]
 * @param {number} [framerate]
 * @returns {VideoEncoderConfig}
 */
export function createVP9EncoderConfig(width, height, bitrate = 5_000_000, framerate = 30) {
  return {
    codec: 'vp09.00.31.08',
    width,
    height,
    bitrate,
    framerate,
    latencyMode: 'realtime',
    hardwareAcceleration: 'prefer-hardware',
  };
}

/**
 * Firefox 互換の VideoEncoder 設定を作成
 * Firefox は hardwareAcceleration, latencyMode オプションをサポートしていないため除外
 * Main Profile (avc1.42E01F) を使用して互換性を向上
 * @param {number} width
 * @param {number} height
 * @param {number} [bitrate]
 * @param {number} [framerate]
 * @param {boolean} [useVP9]
 * @returns {VideoEncoderConfig}
 */
export function createFirefoxCompatibleEncoderConfig(width, height, bitrate = 5_000_000, framerate = 30, useVP9 = false) {
  if (useVP9) {
    return {
      codec: 'vp09.00.31.08',
      width,
      height,
      bitrate,
      framerate,
      hardwareAcceleration: 'prefer-hardware',
      latencyMode: 'realtime',
    };
  }

  return {
    codec: 'avc1.42E01F', // H.264 Main Profile Level 3.1
    width,
    height,
    bitrate,
    framerate,
    hardwareAcceleration: 'prefer-hardware',
    latencyMode: 'realtime',
  };
}

/**
 * エンコーダーを初期化
 * @param {VideoEncoderConfig} config
 * @param {(chunk: EncodedVideoChunk, meta?: EncodedVideoChunkMetadata) => void} onChunk
 * @returns {VideoEncoder}
 */
export function createEncoder(config, onChunk) {
  const encoder = new VideoEncoder({
    output: (chunk, meta) => {
      onChunk(chunk, meta);
    },
    error: (e) => {
      console.error('[VideoEncoder] Error:', e);
      throw e;
    },
  });

  console.log('[VideoEncoder] Configuring with:', config);
  try {
    encoder.configure(config);
    console.log('[VideoEncoder] Configured successfully');
  } catch (e) {
    console.error('[VideoEncoder] Configure error:', e);
    encoder.close();
    throw e;
  }
  return encoder;
}

/**
 * エンコーダーを初期化（フォールバック付き）
 * Firefox 互換性のため、設定エラー時に VP9 へフォールバック
 * @param {VideoEncoderConfig} primaryConfig
 * @param {VideoEncoderConfig} fallbackConfig
 * @param {(chunk: EncodedVideoChunk, meta?: EncodedVideoChunkMetadata) => void} onChunk
 * @returns {Promise<{ encoder: VideoEncoder, usedFallback: boolean }>}
 */
export async function createEncoderWithFallback(primaryConfig, fallbackConfig, onChunk) {
  // configure() は非同期エラーになるため、isConfigSupported の結果に基づいて
  // 実際に configure() に渡す設定を決める（サポート外設定で configure() しない）
  function toBasicConfig(config) {
    return { codec: config.codec, width: config.width, height: config.height, bitrate: config.bitrate, framerate: config.framerate };
  }

  /**
   * @param {VideoEncoderConfig} config
   * @returns {Promise<VideoEncoderConfig | null>} サポートされる設定、なければ null
   */
  async function findSupportedConfig(config) {
    // まずフル設定（hints 含む）でチェック
    const fullCheck = await VideoEncoder.isConfigSupported(config);
    if (fullCheck.supported === true) {
      console.log(`[VideoEncoder] Full config supported: ${config.codec}`);
      return config;
    }
    // ダメなら基本設定のみでチェック
    const basic = toBasicConfig(config);
    const basicCheck = await VideoEncoder.isConfigSupported(basic);
    if (basicCheck.supported === true) {
      console.log(`[VideoEncoder] Basic config supported: ${config.codec}`);
      return basic;
    }
    return null;
  }

  const primarySupported = await findSupportedConfig(primaryConfig);
  if (primarySupported) {
    const encoder = createEncoder(primarySupported, onChunk);
    return { encoder, usedFallback: false };
  }

  const fallbackSupported = await findSupportedConfig(fallbackConfig);
  if (fallbackSupported) {
    const encoder = createEncoder(fallbackSupported, onChunk);
    return { encoder, usedFallback: true };
  }

  throw new Error('Neither primary nor fallback codec is supported');
}

/**
 * H.264 Baseline Profile が利用可能かチェック
 * @returns {Promise<boolean>}
 */
export async function isH264Supported() {
  try {
    const support = await VideoEncoder.isConfigSupported({
      codec: 'avc1.42001f',
      width: 640,
      height: 360,
      bitrate: 1_000_000,
    });
    console.log('[isH264Supported] Result:', support);
    return support.supported === true;
  } catch (e) {
    console.error('[isH264Supported] Error:', e);
    return false;
  }
}

/**
 * VP9 が利用可能かチェック
 * @returns {Promise<boolean>}
 */
export async function isVP9Supported() {
  try {
    const support = await VideoEncoder.isConfigSupported({
      codec: 'vp09.00.31.08',
      width: 640,
      height: 360,
      bitrate: 1_000_000,
    });
    console.log('[isVP9Supported] Result:', support);
    return support.supported === true;
  } catch (e) {
    console.error('[isVP9Supported] Error:', e);
    return false;
  }
}

/**
 * 利用可能なコーデックを調査
 * @returns {Promise<{ h264: boolean, vp9: boolean }>}
 */
export async function checkAvailableCodecs() {
  const [h264, vp9] = await Promise.all([
    isH264Supported(),
    isVP9Supported(),
  ]);
  console.log('[checkAvailableCodecs] H.264:', h264, 'VP9:', vp9);
  return { h264, vp9 };
}
