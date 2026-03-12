// @ts-check
import {
  STAGE_WIDTH,
  STAGE_HEIGHT,
  SCROLL_DURATION,
  FIXED_DURATION,
} from './constants.js';

/**
 * @typedef {import('./types.js').ParsedComment} ParsedComment
 */

/**
 * コメント群に y 座標を割り当てる（衝突回避）
 * ニコニコ準拠：投稿者コメントとユーザーコメントは別の衝突空間を持つ
 * @param {ParsedComment[]} comments - パース済みコメント配列（破壊的に変更）
 * @param {(text: string, fontSize: number, fontFamily: string) => number} measureTextWidth
 */
export function assignPositions(comments, measureTextWidth) {
  // 投稿者 (owner) とユーザー (non-owner) は別の衝突空間
  const ownerComments = comments.filter(c => c.fork === 'owner');
  const userComments = comments.filter(c => c.fork !== 'owner');

  assignGroup(ownerComments, measureTextWidth);
  assignGroup(userComments, measureTextWidth);
}

/**
 * 同一衝突空間内のコメントに y 座標を割り当てる
 * @param {ParsedComment[]} comments
 * @param {(text: string, fontSize: number, fontFamily: string) => number} measureTextWidth
 */
function assignGroup(comments, measureTextWidth) {
  const scrollComments = comments.filter(c => c.position === 'naka');
  const ueComments = comments.filter(c => c.position === 'ue');
  const shitaComments = comments.filter(c => c.position === 'shita');

  assignScrollPositions(scrollComments, measureTextWidth);
  assignFixedPositions(ueComments, 'ue');
  assignFixedPositions(shitaComments, 'shita');
}

/**
 * コメントの表示高さを算出（内部座標）
 * @param {ParsedComment} comment
 * @returns {number}
 */
function getCommentHeight(comment) {
  if (comment.lineCount <= 1) return comment.charSize;
  return (comment.lineCount - 1) * comment.lineHeight + comment.charSize;
}

/**
 * @typedef {object} ActiveScroll
 * @property {number} startTime - 表示開始時刻 (秒)
 * @property {number} endTime - 表示終了時刻 (秒)
 * @property {number} speed - 移動速度 (px/s)
 * @property {number} width - テキスト幅 (px)
 * @property {number} y - y 座標
 * @property {number} height - 表示高さ
 */

/**
 * 2 つのスクロールコメントが同一 Y 行で衝突するか判定
 * ニコニコのスクロール仕様に基づく：
 * - コメントは t=0 で右端、t=fadeStart で左端に到達
 * - フェードアウト領域（0.5 秒）は左端に固定
 * @param {ActiveScroll} existing - 既存コメント
 * @param {{ startTime: number, speed: number, width: number }} candidate - 新規コメント候補
 * @returns {boolean} 衝突する場合 true
 */
function willCollideScroll(existing, candidate) {
  const t0e = existing.startTime;
  const t0c = candidate.startTime;

  // 既存が完全に終了している（フェードアウト含む）
  if (existing.endTime <= t0c) return false;

  // フェードアウト開始時刻（SCROLL_DURATION - 0.5）
  const fadeStart = SCROLL_DURATION - 0.5;

  // 既存コメントが左端に到達する時刻
  const existingLeftReachTime = t0e + fadeStart;

  // 新コメントが右端から出る時刻（t0c）

  // 既存がまだ左端に到達していない場合
  if (existingLeftReachTime > t0c) {
    // 既存の右端位置を計算（t0c 時点）
    const dt = t0c - t0e;
    const existingRightAtT0c = STAGE_WIDTH - existing.speed * dt + existing.width;

    // 既存の右端がまだ画面内（>0）なら衝突の可能性
    if (existingRightAtT0c > 0) {
      return true;
    }
  } else {
    // 既存は既に左端に到達済み（フェードアウト領域またはそれ以降）
    // 新コメントは右端から始まるので衝突しない
    return false;
  }

  return false;
}

/**
 * スクロールコメントの y 座標割り当て
 * 全アクティブコメントを追跡し、各 Y 候補で衝突チェックを行う
 * @param {ParsedComment[]} comments
 * @param {(text: string, fontSize: number, fontFamily: string) => number} measureTextWidth
 */
function assignScrollPositions(comments, measureTextWidth) {
  /** @type {ActiveScroll[]} */
  const activeComments = [];

  for (const comment of comments) {
    const height = getCommentHeight(comment);
    const width = measureTextWidth(comment.body, comment.fontSize, comment.fontFamily);
    comment.width = width;

    // フェードアウト開始時刻を考慮した速度計算
    // t=0 で右端、t=fadeStart で左端
    const fadeStart = SCROLL_DURATION - 0.5;
    const speed = (STAGE_WIDTH + width) / fadeStart;

    const t0 = comment.vposMs / 1000;
    const t1 = t0 + SCROLL_DURATION;

    // 期限切れのアクティブコメントを除去
    for (let i = activeComments.length - 1; i >= 0; i--) {
      if (activeComments[i].endTime <= t0) {
        activeComments.splice(i, 1);
      }
    }

    const candidate = { startTime: t0, speed, width };

    // 上から順に Y 候補を試す（height 刻み）
    let placed = false;
    const step = height; // 1 行分ずつ試す

    for (let candidateY = 0; candidateY + height <= STAGE_HEIGHT; candidateY += step) {
      let collision = false;

      for (const active of activeComments) {
        // Y 方向の重なり判定
        const activeBottom = active.y + active.height;
        const candidateBottom = candidateY + height;
        if (candidateY < activeBottom && candidateBottom > active.y) {
          // Y 方向で重なっている → 時間・X 方向の衝突チェック
          if (willCollideScroll(active, candidate)) {
            collision = true;
            break;
          }
        }
      }

      if (!collision) {
        comment.y = candidateY;
        activeComments.push({
          startTime: t0,
          endTime: t1,
          speed,
          width,
          y: candidateY,
          height,
        });
        placed = true;
        break;
      }
    }

    if (!placed) {
      // オーバーフロー：ニコニコ準拠でランダム配置
      const maxY = STAGE_HEIGHT - height;
      comment.y = maxY > 0 ? Math.random() * maxY : 0;
      activeComments.push({
        startTime: t0,
        endTime: t1,
        speed,
        width,
        y: comment.y,
        height,
      });
    }
  }
}

/**
 * 固定コメント（ue/shita）の y 座標割り当て
 * 高さを累積して密着配置（ニコニコ準拠）
 * @param {ParsedComment[]} comments
 * @param {'ue' | 'shita'} position
 */
function assignFixedPositions(comments, position) {
  /** @type {Array<{ endTime: number, height: number, y: number }>} */
  const rows = [];

  for (const comment of comments) {
    const height = getCommentHeight(comment);
    const t0 = comment.vposMs / 1000;
    const t1 = t0 + FIXED_DURATION;

    let placed = false;

    if (position === 'ue') {
      // 期限切れ行を再利用（上から順に探索）
      for (let row = 0; row < rows.length; row++) {
        if (rows[row].endTime <= t0 + 0.1) {
          const y = rows[row].y;
          if (y + height > STAGE_HEIGHT) break;
          rows[row] = { endTime: t1, height, y };
          comment.y = y;
          placed = true;
          break;
        }
      }
      if (!placed) {
        // 全行の高さを合計して次の空き Y 位置を計算（密着配置）
        const y = rows.reduce((acc, r) => acc + r.height, 0);
        if (y + height <= STAGE_HEIGHT) {
          rows.push({ endTime: t1, height, y });
          comment.y = y;
          placed = true;
        }
      }
      if (!placed) {
        comment.y = 0; // オーバーフロー
      }
    } else {
      // shita: 下から探索・密着配置
      for (let row = 0; row < rows.length; row++) {
        if (rows[row].endTime <= t0 + 0.1) {
          const y = rows[row].y;
          if (y < 0) break;
          rows[row] = { endTime: t1, height, y };
          comment.y = y;
          placed = true;
          break;
        }
      }
      if (!placed) {
        const usedHeight = rows.reduce((acc, r) => acc + r.height, 0);
        const y = STAGE_HEIGHT - usedHeight - height;
        if (y >= 0) {
          rows.push({ endTime: t1, height, y });
          comment.y = y;
          placed = true;
        }
      }
      if (!placed) {
        comment.y = STAGE_HEIGHT - height; // オーバーフロー
      }
    }
  }
}
