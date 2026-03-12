// @ts-check
/**
 * @typedef {object} ParsedComment
 * @property {string} id
 * @property {number} no
 * @property {number} vposMs - 表示開始時刻（ミリ秒）
 * @property {number} endMs - 表示終了時刻（ミリ秒）
 * @property {string} body
 * @property {string[]} commands
 * @property {string} userId
 * @property {boolean} isPremium
 * @property {number} score
 * @property {string} fork
 * @property {string} color - 描画色（#RRGGBB）
 * @property {string} position - 'naka' | 'ue' | 'shita'
 * @property {string} size - 'big' | 'medium' | 'small'
 * @property {number} fontSize - 描画フォントサイズ（内部座標、charSize * 0.8）
 * @property {number} charSize - 1 文字分の衝突判定高さ（内部座標）
 * @property {number} lineHeight - 行間スペーシング（内部座標）
 * @property {number} lineCount - 行数（\n 区切り）
 * @property {string} font - フォント名
 * @property {string} fontFamily - CSS フォントファミリー
 * @property {number} y - y 座標（内部座標、衝突回避後）
 * @property {number} width - テキスト幅（内部座標）
 * @property {boolean} [isResized] - Y-リサイズ適用フラグ
 */

export {};
