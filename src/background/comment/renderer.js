// @ts-check
import {
  STAGE_WIDTH,
  STAGE_HEIGHT,
  SCROLL_DURATION,
  OUTLINE_RATIO,
} from './constants.js';

/**
 * @typedef {import('./types.js').ParsedComment} ParsedComment
 */

/**
 * Canvas2D 上にコメントを描画する
 * @param {OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D} ctx
 * @param {ParsedComment[]} visibleComments
 * @param {number} currentTimeMs
 * @param {number} canvasWidth
 * @param {number} canvasHeight
 */
export function renderComments(ctx, visibleComments, currentTimeMs, canvasWidth, canvasHeight) {
  // ニコニコ準拠：X/Y 独立スケーリング（動画全体にコメントを配置）
  const scaleY = canvasHeight / STAGE_HEIGHT;

  for (const comment of visibleComments) {
    const fontSize = comment.fontSize * scaleY;
    const lineHeight = comment.lineHeight * scaleY;
    const x = calculateX(comment, currentTimeMs, canvasWidth, scaleY);
    const y = comment.y * scaleY;

    const lines = comment.body.split('\n');
    for (let i = 0; i < lines.length; i++) {
      drawCommentText(ctx, lines[i], x, y + i * lineHeight, fontSize, comment.color, comment.fontFamily);
    }
  }
}

/**
 * コメントの x 座標を計算
 * ニコニコのスクロール仕様：
 * - t=0 でコメントの右端が画面右端
 * - t=SCROLL_DURATION-0.5 でコメントの左端が画面左端に到達
 * - その後はフェードアウト領域（約 0.5 秒）
 * @param {ParsedComment} comment
 * @param {number} currentTimeMs
 * @param {number} canvasWidth - 実際のキャンバス幅
 * @param {number} scaleY - 縦方向スケール（フォントサイズ基準）
 * @returns {number}
 */
function calculateX(comment, currentTimeMs, canvasWidth, scaleY) {
  const textWidth = comment.width * scaleY;
  if (comment.position === 'ue' || comment.position === 'shita') {
    return (canvasWidth - textWidth) / 2;
  }

  // 経過時間（秒）
  const elapsed = (currentTimeMs - comment.vposMs) / 1000;

  // フェードアウト開始時刻（SCROLL_DURATION の最後 0.5 秒）
  const fadeStart = SCROLL_DURATION - 0.5;

  if (elapsed >= SCROLL_DURATION) {
    // 完全に表示終了
    return -textWidth;
  }

  if (elapsed >= fadeStart) {
    // フェードアウト領域：左端に固定
    return -textWidth;
  }

  // 通常スクロール領域
  // t=0: x = canvasWidth（コメント右端が画面右端）
  // t=fadeStart: x = -textWidth（コメント左端が画面左端）
  const scrollDistance = canvasWidth + textWidth;
  const scrollProgress = elapsed / fadeStart;
  return canvasWidth - scrollDistance * scrollProgress;
}

/**
 * 縁取り付きテキスト描画
 * ニコニコのコメントは黒い縁取り + 本体描画
 * @param {OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D} ctx
 * @param {string} text
 * @param {number} x
 * @param {number} y
 * @param {number} fontSize
 * @param {string} color
 * @param {string} fontFamily
 */
function drawCommentText(ctx, text, x, y, fontSize, color, fontFamily) {
  ctx.font = `400 ${fontSize}px ${fontFamily}`;
  ctx.textBaseline = 'top';

  // 縁取り（黒）- ニコニコは比較的細めの縁取り
  const outlineWidth = Math.max(1, fontSize * OUTLINE_RATIO);
  ctx.strokeStyle = '#000000';
  ctx.lineWidth = outlineWidth;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.miterLimit = 2;
  // 縁取りは完全に不透明で描画
  ctx.globalAlpha = 1.0;
  ctx.strokeText(text, x, y);

  // 本体描画
  ctx.globalAlpha = 1.0;
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
}

/**
 * テキスト幅を内部座標系で計測する（改行があれば最大行幅を返す）
 * @param {OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D} ctx
 * @param {string} text
 * @param {number} fontSize
 * @param {string} fontFamily
 * @returns {number}
 */
export function measureTextWidth(ctx, text, fontSize, fontFamily) {
  ctx.font = `400 ${fontSize}px ${fontFamily}`;
  const lines = text.split('\n');
  let maxWidth = 0;
  for (const line of lines) {
    const w = ctx.measureText(line).width;
    if (w > maxWidth) maxWidth = w;
  }
  return maxWidth;
}
