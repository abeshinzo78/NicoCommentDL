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
  const codec = useVP9 ? 'vp09.00.31.08' : 'avc1.640028'; // H.264 High Profile Level 4.0
  return {
    codec,
    width,
    height,
    bitrate,              // quantizer 未対応時のフォールバック用
    bitrateMode: 'quantizer', // CRF相当: フレーム単位で品質一定、ビット不足によるブロックノイズを構造的に排除
    framerate,
    hardwareAcceleration: 'prefer-software', // SW エンコーダは QP 制御が正確 + Chrome Offscreen の GPU 制限を回避
    latencyMode: 'realtime',  // 品質は QP が保証するのでレート制御は高速でよい
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
 * @returns {Promise<{ encoder: VideoEncoder, usedFallback: boolean, config: VideoEncoderConfig }>}
 */
export async function createEncoderWithFallback(primaryConfig, fallbackConfig, onChunk) {
  // configure() は非同期エラーになるため、isConfigSupported の結果に基づいて
  // 実際に configure() に渡す設定を決める（サポート外設定で configure() しない）

  /**
   * 段階的フォールバック：品質に最も効くオプションを優先して残す
   * quantizer > VBR+quality > VBR > basic の順で試行
   * @param {VideoEncoderConfig} config
   * @returns {Promise<VideoEncoderConfig | null>} サポートされる設定、なければ null
   */
  async function findSupportedConfig(config) {
    const { codec, width, height, bitrate, framerate } = config;

    /** @type {Array<[string, VideoEncoderConfig]>} */
    const candidates = [
      // 1. Quantizer + SW（QP 精度最高、CPU→GPU 転送なし）
      ['quantizer+sw', { codec, width, height, framerate, bitrateMode: 'quantizer', latencyMode: 'realtime', hardwareAcceleration: 'prefer-software' }],
      // 2. Quantizer のみ（ブラウザが HW/SW を選択）
      ['quantizer', { codec, width, height, framerate, bitrateMode: 'quantizer', latencyMode: 'realtime' }],
      // 3. VBR + SW + quality（ビットレート制御、品質重視）
      ['vbr+sw+quality', { codec, width, height, bitrate, framerate, bitrateMode: 'variable', latencyMode: 'quality', hardwareAcceleration: 'prefer-software' }],
      // 4. VBR のみ
      ['vbr', { codec, width, height, bitrate, framerate, bitrateMode: 'variable' }],
      // 5. 最小設定（ブラウザデフォルト）
      ['basic', { codec, width, height, bitrate, framerate }],
    ];

    for (const [label, candidate] of candidates) {
      const check = await VideoEncoder.isConfigSupported(candidate);
      if (check.supported === true) {
        console.log(`[VideoEncoder] ${label} config supported: ${codec}`, Object.keys(candidate).join(', '));
        return candidate;
      }
    }
    return null;
  }

  // H.264: High Profile → Main Profile → Baseline Profile の順で試行
  // Firefox の OpenH264 は High/Main 非対応だが Baseline は対応している
  const h264Profiles = [
    primaryConfig.codec,   // avc1.640028 (High Profile L4.0)
    'avc1.4D4028',         // Main Profile L4.0
    'avc1.42E028',         // Constrained Baseline L4.0
    'avc1.42001f',         // Baseline L3.1（最も互換性が高い）
  ];

  for (const codec of h264Profiles) {
    const config = await findSupportedConfig({ ...primaryConfig, codec });
    if (config) {
      const encoder = createEncoder(config, onChunk);
      console.log(`[VideoEncoder] Using H.264 profile: ${codec}`);
      return { encoder, usedFallback: false, config };
    }
  }

  // VP9 フォールバック（H.264 が全プロファイルで非対応の場合のみ）
  const fallbackSupported = await findSupportedConfig(fallbackConfig);
  if (fallbackSupported) {
    const encoder = createEncoder(fallbackSupported, onChunk);
    return { encoder, usedFallback: true, config: fallbackSupported };
  }

  throw new Error('Neither H.264 nor VP9 codec is supported');
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
