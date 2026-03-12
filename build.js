import esbuild from 'esbuild';
import { copyFileSync, mkdirSync, existsSync, readdirSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';

// Chrome MV3 Service Worker 用ポリフィル
// - window が存在しないためライブラリ互換用に globalThis へ alias
// - browser 名前空間を chrome の alias として注入
// - alarms で SW が30秒停止されないようにキープアライブ
const CHROME_SW_BANNER = `
if (typeof window === 'undefined') { globalThis.window = globalThis; }
if (typeof browser === 'undefined') { globalThis.browser = chrome; }
// Service Worker にはDOM APIが存在しないためスタブを注入
// niconicomments ライブラリの instanceof チェックを通すためのダミークラス
if (typeof HTMLCanvasElement === 'undefined') { globalThis.HTMLCanvasElement = class HTMLCanvasElement {}; }
if (typeof HTMLImageElement  === 'undefined') { globalThis.HTMLImageElement  = class HTMLImageElement  {}; }
if (typeof HTMLVideoElement  === 'undefined') { globalThis.HTMLVideoElement  = class HTMLVideoElement  {}; }
if (typeof Image             === 'undefined') { globalThis.Image             = class Image             {}; }
if (typeof document === 'undefined') {
  globalThis.document = {
    createElement: function(tag) {
      if (tag === 'canvas') {
        return { getContext: function() { return null; }, width: 0, height: 0 };
      }
      return {};
    },
  };
}
// SW keepalive（ダウンロード中に30秒タイムアウトで停止しないよう）
if (typeof chrome !== 'undefined' && chrome.alarms) {
  chrome.alarms.create('swKeepAlive', { periodInMinutes: 0.4 });
  chrome.alarms.onAlarm.addListener(function() {});
}
`.trim();

// popup / content script 用（window はあるが browser が chrome の alias でない場合がある）
const CHROME_PAGE_BANNER = `
if (typeof browser === 'undefined') { globalThis.browser = chrome; }
`.trim();

async function buildFirefox() {
  const DIST = 'dist';
  mkdirSync(DIST, { recursive: true });
  mkdirSync(join(DIST, 'src/background'), { recursive: true });
  mkdirSync(join(DIST, 'src/popup'), { recursive: true });
  mkdirSync(join(DIST, 'src/content'), { recursive: true });
  mkdirSync(join(DIST, 'icons'), { recursive: true });

  await esbuild.build({
    entryPoints: ['src/background/main.js'],
    bundle: true,
    outfile: join(DIST, 'src/background/main.js'),
    format: 'iife',
    target: 'firefox133',
    minify: false,
    sourcemap: false,
  });

  copyFileSync('src/content/extractor.js', join(DIST, 'src/content/extractor.js'));
  copyFileSync('src/popup/popup.html', join(DIST, 'src/popup/popup.html'));
  copyFileSync('src/popup/popup.js', join(DIST, 'src/popup/popup.js'));
  copyFileSync('src/popup/popup.css', join(DIST, 'src/popup/popup.css'));
  copyFileSync('manifest.json', join(DIST, 'manifest.json'));

  if (existsSync('icons')) {
    for (const file of readdirSync('icons')) {
      copyFileSync(join('icons', file), join(DIST, 'icons', file));
    }
  }

  console.log('Build complete: dist/');
}

async function buildChrome() {
  const DIST = 'dist-chrome';
  mkdirSync(DIST, { recursive: true });
  mkdirSync(join(DIST, 'src/background'), { recursive: true });
  mkdirSync(join(DIST, 'src/popup'), { recursive: true });
  mkdirSync(join(DIST, 'src/content'), { recursive: true });
  mkdirSync(join(DIST, 'src/offscreen'), { recursive: true });
  mkdirSync(join(DIST, 'icons'), { recursive: true });

  // Service Worker (thin router): window + browser + keepalive polyfill を注入
  await esbuild.build({
    entryPoints: ['src/background/sw-chrome.js'],
    bundle: true,
    outfile: join(DIST, 'src/background/sw-chrome.js'),
    format: 'iife',
    target: 'chrome120',
    banner: { js: CHROME_SW_BANNER },
    minify: false,
    sourcemap: false,
  });

  // Offscreen Document: WebCodecs + Canvas2D 処理を担う
  await esbuild.build({
    entryPoints: ['src/offscreen/offscreen.js'],
    bundle: true,
    outfile: join(DIST, 'src/offscreen/offscreen.js'),
    format: 'iife',
    target: 'chrome120',
    banner: { js: CHROME_PAGE_BANNER },
    minify: false,
    sourcemap: false,
  });

  // Popup: browser polyfill を注入してバンドル
  await esbuild.build({
    entryPoints: ['src/popup/popup.js'],
    bundle: true,
    outfile: join(DIST, 'src/popup/popup.js'),
    format: 'iife',
    target: 'chrome120',
    banner: { js: CHROME_PAGE_BANNER },
    minify: false,
    sourcemap: false,
  });

  // Content script: browser polyfill を注入してバンドル
  await esbuild.build({
    entryPoints: ['src/content/extractor.js'],
    bundle: true,
    outfile: join(DIST, 'src/content/extractor.js'),
    format: 'iife',
    target: 'chrome120',
    banner: { js: CHROME_PAGE_BANNER },
    minify: false,
    sourcemap: false,
  });

  copyFileSync('src/popup/popup.html', join(DIST, 'src/popup/popup.html'));
  copyFileSync('src/popup/popup.css', join(DIST, 'src/popup/popup.css'));
  copyFileSync('src/offscreen/offscreen.html', join(DIST, 'src/offscreen/offscreen.html'));
  copyFileSync('manifest-chrome.json', join(DIST, 'manifest.json'));

  if (existsSync('icons')) {
    for (const file of readdirSync('icons')) {
      copyFileSync(join('icons', file), join(DIST, 'icons', file));
    }
  }

  console.log('Build complete: dist-chrome/');
}

const target = process.argv[2];
if (target === '--chrome') {
  await buildChrome();
} else if (target === '--firefox') {
  await buildFirefox();
} else {
  // 引数なしは両方ビルド
  await buildFirefox();
  await buildChrome();
}
