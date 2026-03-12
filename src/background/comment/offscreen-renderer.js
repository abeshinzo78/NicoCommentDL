// @ts-check

/**
 * OffscreenCanvasRenderer
 * niconicomments の IRenderer インターフェースを OffscreenCanvas で実装
 * Background script (DOM なし) 環境で動作するためのアダプター
 */
export class OffscreenCanvasRenderer {
  /** @type {OffscreenCanvas} */
  canvas;
  /** @type {OffscreenCanvasRenderingContext2D} */
  #context;
  /** @type {number} */
  #padding = 0;
  /** @type {number} */
  #width = 0;
  /** @type {number} */
  #height = 0;

  /**
   * @param {OffscreenCanvas} [canvas]
   * @param {number} [padding]
   */
  constructor(canvas, padding = 0) {
    this.canvas = canvas ?? new OffscreenCanvas(1, 1);
    const context = this.canvas.getContext('2d');
    if (!context) throw new Error('Failed to get 2D context from OffscreenCanvas');
    this.#context = context;
    this.#context.textAlign = 'start';
    this.#context.textBaseline = 'alphabetic';
    this.#context.lineJoin = 'round';
    this.#padding = padding;
    this.#width = this.canvas.width;
    this.#height = this.canvas.height;
    if (this.#padding > 0) {
      this.canvas.width += this.#padding * 2;
      this.canvas.height += this.#padding * 2;
      this.#context.translate(this.#padding, this.#padding);
    }
  }

  destroy() {
    // no-op
  }

  /**
   * drawVideo は背景描画で使用される。
   * コメント専用キャンバスでは no-op（動画は別キャンバスで描画）
   */
  drawVideo() {
    // no-op: video is drawn separately in compositor
  }

  /** @returns {string} */
  getFont() {
    return this.#context.font;
  }

  /** @returns {string | CanvasGradient | CanvasPattern} */
  getFillStyle() {
    return this.#context.fillStyle;
  }

  /**
   * @param {number} scaleX
   * @param {number} [scaleY]
   */
  setScale(scaleX, scaleY) {
    this.#context.scale(scaleX, scaleY ?? scaleX);
  }

  /**
   * @param {number} x
   * @param {number} y
   * @param {number} width
   * @param {number} height
   */
  fillRect(x, y, width, height) {
    this.#context.fillRect(x, y, width, height);
  }

  /**
   * @param {number} x
   * @param {number} y
   * @param {number} width
   * @param {number} height
   */
  strokeRect(x, y, width, height) {
    this.#context.strokeRect(x, y, width, height);
  }

  /**
   * @param {string} text
   * @param {number} x
   * @param {number} y
   */
  fillText(text, x, y) {
    this.#context.fillText(text, x, y);
  }

  /**
   * @param {string} text
   * @param {number} x
   * @param {number} y
   */
  strokeText(text, x, y) {
    this.#context.strokeText(text, x, y);
  }

  /**
   * @param {number} cpx
   * @param {number} cpy
   * @param {number} x
   * @param {number} y
   */
  quadraticCurveTo(cpx, cpy, x, y) {
    this.#context.quadraticCurveTo(cpx, cpy, x, y);
  }

  /**
   * @param {number} x
   * @param {number} y
   * @param {number} width
   * @param {number} height
   */
  clearRect(x, y, width, height) {
    this.#context.clearRect(x, y, width, height);
  }

  /** @param {string} font */
  setFont(font) {
    this.#context.font = font;
  }

  /** @param {string} color */
  setFillStyle(color) {
    this.#context.fillStyle = color;
  }

  /** @param {string} color */
  setStrokeStyle(color) {
    this.#context.strokeStyle = color;
  }

  /** @param {number} width */
  setLineWidth(width) {
    this.#context.lineWidth = width;
  }

  /** @param {number} alpha */
  setGlobalAlpha(alpha) {
    this.#context.globalAlpha = alpha;
  }

  /**
   * @param {number} width
   * @param {number} height
   */
  setSize(width, height) {
    this.#width = width;
    this.#height = height;
    this.canvas.width = width + this.#padding * 2;
    this.canvas.height = height + this.#padding * 2;
  }

  /** @returns {{ width: number, height: number }} */
  getSize() {
    return { width: this.#width, height: this.#height };
  }

  /** @param {string} text */
  measureText(text) {
    return this.#context.measureText(text);
  }

  beginPath() {
    this.#context.beginPath();
  }

  closePath() {
    this.#context.closePath();
  }

  /**
   * @param {number} x
   * @param {number} y
   */
  moveTo(x, y) {
    this.#context.moveTo(x, y);
  }

  /**
   * @param {number} x
   * @param {number} y
   */
  lineTo(x, y) {
    this.#context.lineTo(x, y);
  }

  stroke() {
    this.#context.stroke();
  }

  save() {
    this.#context.save();
  }

  restore() {
    this.#context.restore();
  }

  /**
   * 新しいサブキャンバスを生成（コメント画像キャッシュ用）
   * niconicomments 内部で各コメントの描画イメージ生成に使用される
   * @param {number} [padding]
   * @returns {OffscreenCanvasRenderer}
   */
  getCanvas(padding = 0) {
    return new OffscreenCanvasRenderer(undefined, padding);
  }

  /**
   * 別の IRenderer（OffscreenCanvasRenderer）の内容を描画
   * duck-typing: image.canvas プロパティを参照
   * @param {OffscreenCanvasRenderer} image
   * @param {number} x
   * @param {number} y
   * @param {number} [width]
   * @param {number} [height]
   */
  drawImage(image, x, y, width, height) {
    if (!image || !image.canvas) {
      throw new TypeError('drawImage: image must have a canvas property');
    }
    if (width === undefined || height === undefined) {
      this.#context.drawImage(image.canvas, x, y);
    } else {
      this.#context.drawImage(image.canvas, x, y, width, height);
    }
  }
}
