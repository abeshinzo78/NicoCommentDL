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

/** コメント表示の最大持続時間（5秒 = スクロール4.1s / 固定3s を余裕をもってカバー） */
const COMMENT_DISPLAY_DURATION_MS = 5000;

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
  /** @type {number} キャッシュ済み出力幅 */
  #width;
  /** @type {number} キャッシュ済み出力高さ */
  #height;
  /** @type {number} */
  #frameCount = 0;
  /** @type {number} */
  #totalFrames = 0;
  /** @type {number} */
  #timestampOffset = 0;
  /** @type {number} */
  #lastVpos = -1;
  /** @type {number} CFR用フレームレート（デフォルト30fps） */
  #framerate = 30;
  /** @type {number} CFRフレーム間隔（μs）、init時に確定 */
  #cfrIntervalUs = Math.round(1_000_000 / 30);
  /**
   * コメント表示区間のビットマップ（秒単位）
   * commentActiveSeconds[s] === 1 なら、その秒にコメントが表示されている
   * null の場合はタイムライン未構築 → 常にコメント描画を行う（安全側フォールバック）
   * @type {Uint8Array | null}
   */
  #commentActiveSeconds = null;
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
    if (options.framerate) {
      this.#framerate = options.framerate;
      this.#cfrIntervalUs = Math.round(1_000_000 / options.framerate);
    }
    const { width, height } = options;
    this.#width = width;
    this.#height = height;

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

    // コメント表示タイムラインを構築（秒単位ビットマップ）
    // drawCanvas + drawImage の完全スキップ判定に使用
    this.#buildCommentTimeline(threads);

    this.#niconiComments = new NiconiComments(
      this.#commentRenderer,
      threads,
      { format: 'v1', mode: 'default' },
    );

    console.log(`[Compositor] NiconiComments initialized with ${threads.reduce((sum, t) => sum + (t.comments?.length || 0), 0)} comments`);
  }

  /**
   * コメントの表示タイムラインをビットマップとして構築
   * commentActiveSeconds[second] = 1 であれば、その秒にコメントが画面上に存在する
   * @param {any[]} threads
   */
  #buildCommentTimeline(threads) {
    let maxSecond = 0;
    let commentCount = 0;

    for (const thread of threads) {
      for (const comment of (thread.comments || [])) {
        const vposMs = comment.vposMs;
        if (vposMs === undefined || vposMs < 0) continue;
        const endMs = vposMs + COMMENT_DISPLAY_DURATION_MS;
        const endSecond = Math.ceil(endMs / 1000);
        if (endSecond > maxSecond) maxSecond = endSecond;
        commentCount++;
      }
    }

    if (commentCount === 0 || maxSecond === 0) return;

    const timeline = new Uint8Array(maxSecond + 1);
    for (const thread of threads) {
      for (const comment of (thread.comments || [])) {
        const vposMs = comment.vposMs;
        if (vposMs === undefined || vposMs < 0) continue;
        const startSec = Math.max(0, Math.floor(vposMs / 1000));
        const endSec = Math.min(maxSecond, Math.ceil((vposMs + COMMENT_DISPLAY_DURATION_MS) / 1000));
        for (let s = startSec; s <= endSec; s++) {
          timeline[s] = 1;
        }
      }
    }

    this.#commentActiveSeconds = timeline;

    // 統計ログ
    let activeSecs = 0;
    for (let i = 0; i < timeline.length; i++) {
      if (timeline[i]) activeSecs++;
    }
    console.log(`[Compositor] Comment timeline: ${activeSecs}/${timeline.length}s active (${Math.round(activeSecs / timeline.length * 100)}%)`);
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
    while (this.#encoder.encodeQueueSize > 15) {
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
   * 指定 vpos にコメントが表示されているか判定
   * タイムライン未構築時は true を返す（安全側: 常に描画）
   * @param {number} vpos - centiseconds
   * @returns {boolean}
   */
  #hasCommentsAt(vpos) {
    if (!this.#niconiComments) return false;
    const tl = this.#commentActiveSeconds;
    if (!tl) return true; // タイムライン未構築 → 安全側で常に描画
    const sec = Math.floor(vpos / 100);
    return sec >= 0 && sec < tl.length && tl[sec] === 1;
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

    // 前フレームの canvas 書き込み〜encode が終わってから実行
    const p = this.#processingChain.then(() =>
      this.#encodeFrame(videoFrame, bitmapPromise, rawTimestamp)
    );
    // エラーでチェーンが止まらないようにする
    this.#processingChain = p.catch(() => {});
    return p;
  }

  /**
   * @param {VideoFrame} videoFrame
   * @param {Promise<ImageBitmap>} bitmapPromise
   * @param {number} rawTimestamp
   */
  async #encodeFrame(videoFrame, bitmapPromise, rawTimestamp) {
    // コメントタイミング用：ソースのタイムスタンプを使う（オフセット補正済み）
    const vpos = Math.floor((rawTimestamp - this.#timestampOffset) / 10000); // μs → centiseconds

    // コメント表示判定：タイムラインで不在区間なら drawCanvas + drawImage を完全スキップ
    const hasComments = this.#hasCommentsAt(vpos);

    // ★ コメント描画を await 前に実行：drawCanvas がメインスレッドをブロックしている間に
    //   createImageBitmap がブラウザスレッドで並列完了する（bitmap 待ち時間を隠蔽）
    if (hasComments && vpos !== this.#lastVpos) {
      this.#niconiComments.drawCanvas(vpos);
      this.#lastVpos = vpos;
    }

    // バックプレッシャー：エンコーダキューが溢れている場合のみ待機（通常はスキップ）
    if (this.#encoder.encodeQueueSize > 15) {
      await this.#waitForEncoder();
    }

    // drawCanvas 中に bitmapPromise はほぼ完了済み → await は即座に解決
    const bitmap = await bitmapPromise;
    videoFrame.close();

    // 動画フレームを描画
    this.#videoCtx.drawImage(bitmap, 0, 0, this.#width, this.#height);
    bitmap.close();

    // コメントレイヤーを合成（コメント不在区間では完全スキップ）
    if (hasComments) {
      this.#videoCtx.drawImage(this.#commentCanvas, 0, 0);
    }

    // エンコード（CFR タイムスタンプと固定 duration を使用）
    const composited = new VideoFrame(this.#videoCanvas, {
      timestamp: this.#frameCount * this.#cfrIntervalUs,
      duration: this.#cfrIntervalUs,
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
    this.#commentActiveSeconds = null;
  }
}
