// @ts-check
import { parseCommands } from './commands.js';
import {
  SCROLL_DURATION,
  FIXED_DURATION,
  getCharSize,
  getLineHeight,
  getFontSize,
  getResizedCharSize,
  getResizedLineHeight,
  getResizedFontSize,
  LINE_BREAK_COUNT,
} from './constants.js';

/**
 * nvComment API レスポンスからコメントリストをパースする
 * Y-リサイズ処理を含む
 * @param {object} nvCommentResponse - /v1/threads レスポンスの data
 * @returns {Array<import('./types.js').ParsedComment>}
 */
export function parseComments(nvCommentResponse) {
  const results = [];

  if (!nvCommentResponse || !nvCommentResponse.threads) {
    return results;
  }

  for (const thread of nvCommentResponse.threads) {
    if (!thread.comments) continue;

    const fork = thread.fork;

    for (const comment of thread.comments) {
      const parsed = parseCommands(comment.commands || [], comment.isPremium || false);
      const vposMs = comment.vposMs;
      const duration = parsed.position === 'naka' ? SCROLL_DURATION * 1000 : FIXED_DURATION * 1000;
      const lineCount = (comment.body || '').split('\n').length;

      results.push({
        id: comment.id,
        no: comment.no,
        vposMs,
        endMs: vposMs + duration,
        body: comment.body,
        commands: comment.commands || [],
        userId: comment.userId,
        isPremium: comment.isPremium || false,
        score: comment.score || 0,
        fork,
        color: parsed.color,
        position: parsed.position,
        size: parsed.size,
        fontSize: getFontSize(parsed.size),
        charSize: getCharSize(parsed.size),
        lineHeight: getLineHeight(parsed.size),
        lineCount,
        font: parsed.font,
        fontFamily: parsed.fontFamily,
        isResized: false,
        // y 座標は衝突回避で後から設定
        y: -1,
        width: -1,
      });
    }
  }

  // vposMs で安定ソート（同一時刻は no が小さい順）
  results.sort((a, b) => a.vposMs - b.vposMs || a.no - b.no);

  // Y-リサイズを適用：連続する行数を考慮
  applyYResize(results);

  return results;
}

/**
 * Y-リサイズを適用：連続する行数をカウントして再計算
 * ニコニコの仕様：同じ位置（naka/ue/shita）と同じサイズのコメントが
 * 指定行数以上連続すると、フォントサイズが縮小される
 * @param {Array<import('./types.js').ParsedComment>} comments
 */
function applyYResize(comments) {
  // 位置とサイズごとに連続カウンタを管理
  /** @type {Map<string, Array<{index: number, count: number}>} */
  const positionSizeHistory = new Map();

  for (let i = 0; i < comments.length; i++) {
    const comment = comments[i];
    const key = `${comment.position}-${comment.size}`;

    if (!positionSizeHistory.has(key)) {
      positionSizeHistory.set(key, []);
    }

    const history = positionSizeHistory.get(key);

    // 直前のコメントと同じ位置・サイズか確認（連続判定）
    let consecutiveCount = 0;
    if (history.length > 0) {
      const last = history[history.length - 1];
      // 最後のコメントから 5 秒以内（スクロールコメントの表示時間内）なら連続と判定
      const timeDiff = comment.vposMs - comments[last.index].vposMs;
      if (timeDiff < 5000) {
        consecutiveCount = last.count + 1;
      } else {
        consecutiveCount = 1;
      }
    } else {
      consecutiveCount = 1;
    }

    history.push({ index: i, count: consecutiveCount });

    // 指定行数以上連続したら Y-リサイズ発動
    if (consecutiveCount >= LINE_BREAK_COUNT[comment.size]) {
      // 直前の指定行数分のコメントをさかのぼってリサイズ設定
      for (let j = 0; j < LINE_BREAK_COUNT[comment.size]; j++) {
        const targetIndex = i - j;
        if (targetIndex < 0) break;
        const target = comments[targetIndex];
        if (target.position === comment.position && target.size === comment.size) {
          target.isResized = true;
          target.fontSize = getResizedFontSize(target.size);
          target.charSize = getResizedCharSize(target.size);
          target.lineHeight = getResizedLineHeight(target.size);
        }
      }
    }
  }
}

/**
 * 指定時刻に表示すべきコメントをフィルタリング
 * @param {Array<import('./types.js').ParsedComment>} comments
 * @param {number} currentTimeMs - 現在の再生時刻（ミリ秒）
 * @returns {Array<import('./types.js').ParsedComment>}
 */
export function getVisibleComments(comments, currentTimeMs) {
  return comments.filter(c => currentTimeMs >= c.vposMs && currentTimeMs < c.endMs);
}
