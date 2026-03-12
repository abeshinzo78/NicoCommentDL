// @ts-check
import NiconiComments from '@xpadev-net/niconicomments';
import { OffscreenCanvasRenderer } from '../comment/offscreen-renderer.js';
import {
  createEncoderWithFallback,
  createFirefoxCompatibleEncoderConfig,
} from './encoder.js';

/**
 * @typedef {object} CompositorOptions
 * @property {number} width
 * @property {number} height
 * @property {number} [bitrate]
 * @property {number} [framerate]
 * @property {(chunk: EncodedVideoChunk, meta?: EncodedVideoChunkMetadata) => void} onEncodedChunk
 * @property {(progress: number, total: number) => void} [onProgress]
 */

/**
 * コメント合成パイプライン
 * niconicomments ライブラリを使用してニコニコ公式準拠のコメント描画を行う
 */
export class Compositor {
  /** @type {OffscreenCanvas} */
  #videoCanvas;
  /** @type {OffscreenCanvasRenderingContext2D} */
  #videoCtx;
  /** @type {OffscreenCanvas} */
  #commentCanvas;
  /** @type {OffscreenCanvasRenderer} */
  #commentRenderer;
  /** @type {any} niconicomments instance */
  #niconiComments = null;
  /** @type {VideoEncoder | null} */
  #encoder = null;
  /** @type {CompositorOptions} */
  #options;
  /** @type {number} */
  #frameCount = 0;
  /** @type {number} */
  #totalFrames = 0;
  /** @type {number} */
  #timestampOffset = 0;
  /** @type {number} */
  #lastVpos = -1;
  /**
   * フレーム処理のシリアル化チェーン
   * createImageBitmap は並列実行するが、canvas 書き込み〜encode は必ず 1 フレームずつ順番に行う
   * @type {Promise<void>}
   */
  #processingChain = Promise.resolve();

  /**
   * @param {CompositorOptions} options
   */
  constructor(options) {
    this.#options = options;
    const { width, height } = options;

    // 動画フレーム描画用キャンバス（最終出力サイズ）
    this.#videoCanvas = new OffscreenCanvas(width, height);
    const ctx = this.#videoCanvas.getContext('2d');
    if (!ctx) throw new Error('Failed to get 2D context for video canvas');
    this.#videoCtx = ctx;

    // コメント描画用キャンバス（niconicomments が使用）
    // フル解像度: comments are drawn at video resolution
    this.#commentCanvas = new OffscreenCanvas(width, height);
    this.#commentRenderer = new OffscreenCanvasRenderer(this.#commentCanvas);
  }

  /**
   * コメントデータを設定（nvComment API レスポンス）
   * @param {object} nvCommentData - fetchComments() の戻り値（json.data）
   */
  setComments(nvCommentData) {
    const threads = nvCommentData.threads;
    if (!threads || !Array.isArray(threads)) {
      console.warn('[Compositor] No comment threads found');
      return;
    }

    // valibot バリデーション対策：欠落しうるフィールドを補完
    for (const thread of threads) {
      if (thread.commentCount === undefined) thread.commentCount = thread.comments?.length ?? 0;
      for (const comment of (thread.comments || [])) {
        if (comment.isMyPost === undefined) comment.isMyPost = false;
        if (comment.nicoruId === undefined) comment.nicoruId = null;
        if (comment.nicoruCount === undefined) comment.nicoruCount = 0;
        if (comment.score === undefined) comment.score = 0;
        if (comment.source === undefined) comment.source = 'leaf';
        if (comment.commands === undefined) comment.commands = [];
      }
    }

    this.#niconiComments = new NiconiComments(
      this.#commentRenderer,
      threads,
      { format: 'v1', mode: 'default' },
    );

    console.log(`[Compositor] NiconiComments initialized with ${threads.reduce((sum, t) => sum + (t.comments?.length || 0), 0)} comments`);
  }

  /**
   * エンコーダーを初期化
   */
  async init() {
    const { width, height, bitrate, framerate, onEncodedChunk } = this.#options;

    console.log('[Compositor] Initializing encoder...', { width, height, bitrate, framerate });

    const primaryConfig = createFirefoxCompatibleEncoderConfig(width, height, bitrate, framerate, false);
    const fallbackConfig = createFirefoxCompatibleEncoderConfig(width, height, bitrate, framerate, true);

    const { encoder, usedFallback } = await createEncoderWithFallback(primaryConfig, fallbackConfig, onEncodedChunk);
    this.#encoder = encoder;
    console.log(`[Compositor] Encoder initialized with ${usedFallback ? 'VP9 (fallback)' : 'H.264'}`);
  }

  /**
   * @param {number} totalFrames
   */
  setTotalFrames(totalFrames) {
    this.#totalFrames = totalFrames;
  }

  /**
   * エンコーダーのキューが空くのを待つ（バックプレッシャー制御）
   * dequeue イベントで即座に通知を受け取る
   * @private
   */
  async #waitForEncoder() {
    if (!this.#encoder) return;
    while (this.#encoder.encodeQueueSize > 10) {
      await new Promise(resolve => {
        this.#encoder.addEventListener('dequeue', resolve, { once: true });
      });
    }
  }

  /**
   * @param {number} offset
   */
  setTimestampOffset(offset) {
    this.#timestampOffset = offset;
  }

  /**
   * VideoFrame にコメントを合成してエンコード
   *
   * 並列フレーム処理による canvas 競合を防ぐため、#processingChain でシリアル化する。
   * createImageBitmap（YUV→RGBA 変換）だけは各フレームで即座に開始して並列化する。
   *
   * @param {VideoFrame} videoFrame
   */
  processFrame(videoFrame) {
    if (!this.#encoder) {
      videoFrame.close();
      return Promise.reject(new Error('Compositor: Encoder not initialized. Call init() before processFrame().'));
    }

    // createImageBitmap は今すぐ開始（前フレームの処理を待たず並列変換）
    const bitmapPromise = createImageBitmap(videoFrame);
    // videoFrame のタイムスタンプは close() 前に取り出しておく
    const rawTimestamp = videoFrame.timestamp;
    const frameDuration = videoFrame.duration || undefined;

    // 前フレームの canvas 書き込み〜encode が終わってから実行
    const p = this.#processingChain.then(() =>
      this.#encodeFrame(videoFrame, bitmapPromise, rawTimestamp, frameDuration)
    );
    // エラーでチェーンが止まらないようにする
    this.#processingChain = p.then(() => {}, () => {});
    return p;
  }

  /**
   * @param {VideoFrame} videoFrame
   * @param {Promise<ImageBitmap>} bitmapPromise
   * @param {number} rawTimestamp
   * @param {number | undefined} frameDuration
   */
  async #encodeFrame(videoFrame, bitmapPromise, rawTimestamp, frameDuration) {
    const { width, height } = this.#options;
    const normalizedTimestamp = rawTimestamp - this.#timestampOffset;
    const currentTimeMs = normalizedTimestamp / 1000; // μs → ms
    const vpos = Math.floor(currentTimeMs / 10); // ms → centiseconds

    // エンコーダーバックプレッシャー制御（bitmap 変換と並列で走る）
    await this.#waitForEncoder();

    // 変換済み ImageBitmap を受け取り（通常はすでに完了済み）
    const bitmap = await bitmapPromise;
    videoFrame.close();

    // 動画フレームを描画
    this.#videoCtx.drawImage(bitmap, 0, 0, width, height);
    bitmap.close();

    // コメントを描画（vpos 変化時のみ再描画）
    if (this.#niconiComments && vpos !== this.#lastVpos) {
      this.#niconiComments.drawCanvas(vpos);
      this.#lastVpos = vpos;
    }

    // コメントレイヤーを合成
    if (this.#niconiComments) {
      this.#videoCtx.drawImage(this.#commentCanvas, 0, 0);
    }

    // エンコード
    const composited = new VideoFrame(this.#videoCanvas, {
      timestamp: Math.max(0, normalizedTimestamp),
      duration: frameDuration,
    });

    const keyFrame = this.#frameCount % 120 === 0;
    this.#encoder.encode(composited, { keyFrame });
    composited.close();

    this.#frameCount++;
    if (this.#options.onProgress && this.#totalFrames > 0) {
      this.#options.onProgress(this.#frameCount, this.#totalFrames);
    }
  }

  /**
   * 全フレーム処理完了後にフラッシュ
   */
  async flush() {
    // シリアル化チェーンが全部終わるのを待ってからフラッシュ
    await this.#processingChain;
    if (this.#encoder) {
      await this.#encoder.flush();
      this.#encoder.close();
      this.#encoder = null;
    }
  }

  /**
   * リソース解放
   */
  dispose() {
    if (this.#encoder) {
      this.#encoder.close();
      this.#encoder = null;
    }
    this.#niconiComments = null;
    this.#videoCanvas = null;
    this.#commentRenderer = null;
  }
}
