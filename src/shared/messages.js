// @ts-check

/**
 * @typedef {'EXTRACT_WATCH_DATA' | 'WATCH_DATA_READY' | 'START_DOWNLOAD' | 'DOWNLOAD_PROGRESS' | 'DOWNLOAD_COMPLETE' | 'DOWNLOAD_ERROR' | 'GET_STATUS'} MessageType
 */

/**
 * @typedef {object} ProgressInfo
 * @property {string} stage - 'hls' | 'comments' | 'encoding' | 'muxing' | 'complete' | 'error'
 * @property {string} message
 * @property {number} current
 * @property {number} total
 * @property {number} percent
 */

/**
 * @typedef {object} DownloadRequest
 * @property {string} videoId
 * @property {string} [preferredQuality]
 */

/**
 * メッセージ送信ヘルパー
 * @param {browser.runtime.MessageSender | null} _sender
 * @param {MessageType} type
 * @param {any} data
 */
export function sendMessage(type, data) {
  return browser.runtime.sendMessage({ type, data });
}

/**
 * アクティブタブにメッセージ送信
 * @param {number} tabId
 * @param {MessageType} type
 * @param {any} data
 */
export function sendTabMessage(tabId, type, data) {
  return browser.tabs.sendMessage(tabId, { type, data });
}
