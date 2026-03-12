// @ts-check

/** 内部座標系（ニコニコ公式プレイヤー準拠 683x384） */
export const STAGE_WIDTH = 683;
export const STAGE_HEIGHT = 384;

/** 固定コメント (ue/shita) の幅制限（full コマンドなしの場合 512） */
export const COMMENT_STAGE_WIDTH = 512;

/** スクロールコメント (naka) の表示時間（秒）— ニコニコ公式 4 秒 */
export const SCROLL_DURATION = 4;
/** 固定コメント (ue/shita) の表示時間（秒） */
export const FIXED_DURATION = 3;

/**
 * HTML5 プレイヤーの行数テーブル（niconicomments 準拠）
 * charSize/lineHeight 算出に使用
 */
export const LINE_COUNTS = {
  default: { big: 8.4, medium: 13.1, small: 21 },
  resized: { big: 16, medium: 25.4, small: 38 },
  doubleResized: { big: 7.8, medium: 11.3, small: 16.6 },
};

/** Y-リサイズ発動行数しきい値 */
export const LINE_BREAK_COUNT = { big: 3, medium: 5, small: 7 };

/**
 * charSize: 1 文字分の衝突判定用高さ（内部座標）
 * @param {'big'|'medium'|'small'} size
 * @returns {number}
 */
export function getCharSize(size) {
  return STAGE_HEIGHT / LINE_COUNTS.doubleResized[size];
}

/**
 * lineHeight: 行間スペーシング（内部座標）
 * @param {'big'|'medium'|'small'} size
 * @returns {number}
 */
export function getLineHeight(size) {
  const cs = getCharSize(size);
  return (STAGE_HEIGHT - cs) / (LINE_COUNTS.default[size] - 1);
}

/**
 * 描画用フォントサイズ = charSize * 0.8
 * @param {'big'|'medium'|'small'} size
 * @returns {number}
 */
export function getFontSize(size) {
  return getCharSize(size) * 0.8;
}

/**
 * Y-リサイズ後の charSize
 * @param {'big'|'medium'|'small'} size
 * @returns {number}
 */
export function getResizedCharSize(size) {
  return getCharSize(size) * LINE_COUNTS.default[size] / LINE_COUNTS.resized[size];
}

/**
 * Y-リサイズ後の行間
 * @param {'big'|'medium'|'small'} size
 * @returns {number}
 */
export function getResizedLineHeight(size) {
  const rcs = getResizedCharSize(size);
  return (STAGE_HEIGHT - rcs) / (LINE_COUNTS.resized[size] - 1);
}

/**
 * Y-リサイズ後の描画フォントサイズ
 * @param {'big'|'medium'|'small'} size
 * @returns {number}
 */
export function getResizedFontSize(size) {
  return getResizedCharSize(size) * 0.8;
}

/** フォントサイズ（HTML5, charSize * 0.8 の近似値） */
export const FONT_SIZE = {
  big: 54,
  medium: 36,
  small: 24,
};

/** 通常会員用カラープリセット */
export const COLORS_NORMAL = {
  white: '#FFFFFF',
  red: '#FF0000',
  pink: '#FF8080',
  orange: '#FFC000',
  yellow: '#FFFF00',
  green: '#00FF00',
  cyan: '#00FFFF',
  blue: '#0000FF',
  purple: '#C000FF',
  black: '#000000',
};

/** プレミアム会員専用カラー */
export const COLORS_PREMIUM = {
  white2: '#CCCC99',
  niconicowhite: '#CCCC99',
  red2: '#CC0033',
  truered: '#CC0033',
  orange2: '#FF6600',
  passionorange: '#FF6600',
  yellow2: '#999900',
  madyellow: '#999900',
  green2: '#00CC66',
  elementalgreen: '#00CC66',
  cyan2: '#00CCCC',
  blue2: '#3399FF',
  marineblue: '#3399FF',
  purple2: '#6633CC',
  nobleviolet: '#6633CC',
  black2: '#666666',
};

/** フォントファミリー */
export const FONTS = {
  gothic: '"Segoe UI", "Meiryo", "Hiragino Kaku Gothic ProN", "MS PGothic", "IPAMonaPGothic", "IPA Gothic", sans-serif',
  mincho: '"MS PMincho", "Hiragino Mincho ProN", serif',
  defont: '"MS PGothic", "Hiragino Kaku Gothic ProN", "IPAMonaPGothic", sans-serif',
};

/** デフォルト色 */
export const DEFAULT_COLOR = '#FFFFFF';

/** デフォルトフォントサイズ */
export const DEFAULT_FONT_SIZE = 'medium';

/** デフォルトフォント */
export const DEFAULT_FONT = 'defont';

/** デフォルト表示位置 */
export const DEFAULT_POSITION = 'naka';

/** 縁取りの太さ（1920px キャンバスで 2.8px → 内部座標で約 1.0px） */
export const OUTLINE_RATIO = 0.073;
