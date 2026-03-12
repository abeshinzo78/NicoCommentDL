// @ts-check
import {
  COLORS_NORMAL,
  COLORS_PREMIUM,
  FONTS,
  DEFAULT_COLOR,
  DEFAULT_FONT_SIZE,
  DEFAULT_FONT,
  DEFAULT_POSITION,
} from './constants.js';

/**
 * コマンド配列を解析して描画パラメータを返す
 * @param {string[]} commands - コメントの commands 配列
 * @param {boolean} isPremium - プレミアム会員かどうか
 * @returns {{ color: string, position: string, size: string, fontSize: number, font: string, fontFamily: string }}
 */
export function parseCommands(commands, isPremium = false) {
  let color = DEFAULT_COLOR;
  let position = DEFAULT_POSITION;
  let size = DEFAULT_FONT_SIZE;
  let font = DEFAULT_FONT;

  if (!commands || commands.length === 0) {
    return {
      color,
      position,
      size,
      fontSize: 36,
      font,
      fontFamily: FONTS[font],
    };
  }

  for (const cmd of commands) {
    const lower = cmd.toLowerCase();

    // 位置コマンド
    if (lower === 'ue' || lower === 'shita' || lower === 'naka') {
      position = lower;
      continue;
    }

    // サイズコマンド
    if (lower === 'big' || lower === 'medium' || lower === 'small') {
      size = lower;
      continue;
    }

    // フォントコマンド
    if (lower === 'gothic' || lower === 'mincho' || lower === 'defont') {
      font = lower;
      continue;
    }

    // #RRGGBB 直接指定（プレミアムのみ）
    if (/^#[0-9A-Fa-f]{6}$/.test(cmd) && isPremium) {
      color = cmd.toUpperCase();
      continue;
    }

    // 名前付きカラー（通常）
    if (COLORS_NORMAL[lower] !== undefined) {
      color = COLORS_NORMAL[lower];
      continue;
    }

    // 名前付きカラー（プレミアム専用）
    if (isPremium && COLORS_PREMIUM[lower] !== undefined) {
      color = COLORS_PREMIUM[lower];
      continue;
    }
  }

  return {
    color,
    position,
    size,
    fontSize: 36,
    font,
    fontFamily: FONTS[font],
  };
}
