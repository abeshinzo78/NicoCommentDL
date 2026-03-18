# NicoCommentDL

ニコニコ動画のコメント付き動画をダウンロードするブラウザ拡張機能です。
[niconicomments](https://github.com/xpadev-net/niconicomments) による公式プレイヤー互換のコメント描画を、WebCodecs API でリアルタイム合成し MP4 として保存します。

[![zread](https://img.shields.io/badge/Ask_Zread-_.svg?style=flat&color=00b0aa&labelColor=000000&logo=data%3Aimage%2Fsvg%2Bxml%3Bbase64%2CPHN2ZyB3aWR0aD0iMTYiIGhlaWdodD0iMTYiIHZpZXdCb3g9IjAgMCAxNiAxNiIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj4KPHBhdGggZD0iTTQuOTYxNTYgMS42MDAxSDIuMjQxNTZDMS44ODgxIDEuNjAwMSAxLjYwMTU2IDEuODg2NjQgMS42MDE1NiAyLjI0MDFWNC45NjAxQzEuNjAxNTYgNS4zMTM1NiAxLjg4ODEgNS42MDAxIDIuMjQxNTYgNS42MDAxSDQuOTYxNTZDNS4zMTUwMiA1LjYwMDEgNS42MDE1NiA1LjMxMzU2IDUuNjAxNTYgNC45NjAxVjIuMjQwMUM1LjYwMTU2IDEuODg2NjQgNS4zMTUwMiAxLjYwMDEgNC45NjE1NiAxLjYwMDFaIiBmaWxsPSIjZmZmIi8%2BCjxwYXRoIGQ9Ik00Ljk2MTU2IDEwLjM5OTlIMi4yNDE1NkMxLjg4ODEgMTAuMzk5OSAxLjYwMTU2IDEwLjY4NjQgMS42MDE1NiAxMS4wMzk5VjEzLjc1OTlDMS42MDE1NiAxNC4xMTM0IDEuODg4MSAxNC4zOTk5IDIuMjQxNTYgMTQuMzk5OUg0Ljk2MTU2QzUuMzE1MDIgMTQuMzk5OSA1LjYwMTU2IDE0LjExMzQgNS42MDE1NiAxMy43NTk5VjExLjAzOTlDNS42MDE1NiAxMC42ODY0IDUuMzE1MDIgMTAuMzk5OSA0Ljk2MTU2IDEwLjM5OTlaIiBmaWxsPSIjZmZmIi8%2BCjxwYXRoIGQ9Ik0xMy43NTg0IDEuNjAwMUgxMS4wMzg0QzEwLjY4NSAxLjYwMDEgMTAuMzk4NCAxLjg4NjY0IDEwLjM5ODQgMi4yNDAxVjQuOTYwMUMxMC4zOTg0IDUuMzEzNTYgMTAuNjg1IDUuNjAwMSAxMS4wMzg0IDUuNjAwMUgxMy43NTg0QzE0LjExMTkgNS42MDAxIDE0LjM5ODQgNS4zMTM1NiAxNC4zOTg0IDQuOTYwMVYyLjI0MDFDMTQuMzk4NCAxLjg4NjY0IDE0LjExMTkgMS42MDAxIDEzLjc1ODQgMS42MDAxWiIgZmlsbD0iI2ZmZiIvPgo8cGF0aCBkPSJNNCAxMkwxMiA0TDQgMTJaIiBmaWxsPSIjZmZmIi8%2BCjxwYXRoIGQ9Ik00IDEyTDEyIDQiIHN0cm9rZT0iI2ZmZiIgc3Ryb2tlLXdpZHRoPSIxLjUiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIvPgo8L3N2Zz4K&logoColor=ffffff)](https://zread.ai/abeshinzo78/nicocommentDL)

[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/abeshinzo78/nicocommentDL)

> [!NOTE]
> **Firefox 140+ / Chrome 116+ の両方に対応しています。**

## 特徴

- **公式互換のコメント描画** — niconicomments が `ue`/`shita`/`big`/`small`/色コマンド等を含むニコニコ公式プレイヤーの描画ロジックを再現
- **ストリーミング処理** — HLS セグメントを逐次ダウンロード・デコード・合成・エンコードするパイプライン設計で、動画全体をメモリに載せない
- **CFR 出力** — フレーム番号ベースの固定フレームレートタイムスタンプにより、VFR 起因の音ズレや再生互換問題を回避
- **解像度自動適応** — ビットレートを解像度に応じて自動設定（1080p: 4Mbps / 720p: 2.5Mbps / 480p: 1.8Mbps / 360p: 1.2Mbps）
- **音声並列処理** — 映像エンコードと音声セグメントのダウンロード・mux を並列実行し、待ち時間を削減

## 実際にダウンロードしたもの

大外刈りやコードなどのコメントが正確に描写できていることがわかると思います。

https://github.com/user-attachments/assets/ac07223a-1949-4e3e-9f3f-bd6026d50a83

## インストール

[Releases](https://github.com/abeshinzo78/NicoCommentDL/releases/) から最新版をダウンロードしてください。

- **Firefox**: `.xpi` ファイルをダウンロードしてインストール
- **Chrome**: `.zip` を解凍 →`chrome://extensions` → デベロッパーモード ON →「パッケージ化されていない拡張機能を読み込む」

## 使い方

1. ニコニコ動画の動画ページ (`nicovideo.jp/watch/*`) を開く
2. 拡張機能アイコンをクリック
3. 画質を選択してダウンロード開始

## アーキテクチャ

### 処理パイプライン

```
Content Script          Background / Offscreen Document
─────────────          ────────────────────────────────
ページから               HLS Master Playlist 解析
視聴データ抽出    →      ├── 映像セグメント (並列プリフェッチ)
Cookie付き              │     ├── AES-128-CBC 復号
Fetch代理       →      │     ├── fMP4 パース → VideoDecoder
                       │     ├── createImageBitmap (YUV→RGBA)
nvComment API          │     ├── niconicomments.drawCanvas(vpos)
コメント取得     →      │     ├── Canvas2D 合成
                       │     ├── VideoEncoder (H.264/VP9)
                       │     └── MP4 Muxer
                       ├── 音声セグメント (映像と並列)
                       │     └── AAC チャンクを直接 Muxer へ
                       └── MP4 ファイナライズ → ダウンロード
```

### フレーム合成の詳細 (compositor.js)

```
processFrame(videoFrame)
  ├── createImageBitmap(videoFrame)    ← ブラウザスレッドで YUV→RGBA 変換
  │
  └── #processingChain (シリアル化キュー)
        └── #encodeFrame()
              1. niconicomments.drawCanvas(vpos)  ← コメント描画 (同期)
              │   ※ createImageBitmap と並列実行される
              2. await bitmapPromise
              3. ctx.drawImage(bitmap)            ← 動画フレーム
              4. ctx.drawImage(commentCanvas)     ← コメントレイヤー合成
              5. new VideoFrame → encoder.encode() → Muxer
```

`drawCanvas()` の同期実行中に `createImageBitmap` がブラウザスレッドで並列完了するため、bitmap の await は即座に解決します。

### コメント不在区間の最適化

動画読み込み時にコメントの出現タイムラインを秒単位の `Uint8Array` ビットマップとして構築します。コメントが存在しない区間では `drawCanvas()` と `drawImage(commentCanvas)` を完全にスキップし、動画フレームのみをエンコードします。

### バックプレッシャー制御

```
HLS セグメント取得  →  VideoDecoder (キュー上限 16)
                         ↓
                    未処理フレーム (上限 8)
                         ↓
                    VideoEncoder (キュー上限 15)
```

各段にキュー上限を設け、溜まりすぎた場合は上流を一時停止します。これにより長時間動画でもメモリ使用量が一定に保たれます。

### Firefox / Chrome の違い

| | Firefox (MV2) | Chrome (MV3) |
|---|---|---|
| マニフェスト | Manifest V2 | Manifest V3 |
| WebCodecs 実行場所 | Background Event Page | Offscreen Document |
| ルーティング | background/main.js が全処理 | Service Worker → Offscreen Document に委譲 |
| SW keepalive | 不要 | `chrome.alarms` で30秒タイムアウト回避 |
| エンコーダ | H.264 Main Profile → VP9 フォールバック | H.264 Baseline → VP9 フォールバック |

## 仕様

| 項目 | 内容 |
|---|---|
| 対応サイト | `nicovideo.jp/watch/*` |
| 出力形式 | MP4 (H.264 + AAC / VP9 + AAC) |
| コメント描画 | [niconicomments](https://github.com/xpadev-net/niconicomments) v0.2.76 |
| フレームレート | ソース動画に合わせた CFR (通常 30fps) |
| キーフレーム間隔 | 120 フレーム (30fps で 4秒) |
| HLS セグメント並列数 | 6 (映像・音声それぞれ) |
| 暗号化 | AES-128-CBC (HLS EXT-X-KEY) |
| MP4 Muxer | [mp4-muxer](https://github.com/nicovideo/niconicomments) v5.0.0 (`fastStart: 'in-memory'`) |

## 開発

### ビルド

```bash
git clone https://github.com/abeshinzo78/nicocommentDL.git
cd nicocommentDL
npm install
npm run build          # Firefox (dist/) + Chrome (dist-chrome/) 両方
npm run build:firefox  # Firefox のみ
npm run build:chrome   # Chrome のみ
```

ビルドシステムは esbuild で、各エントリポイントを IIFE 形式にバンドルします。

### デバッグ用インストール

**Firefox**: `about:debugging` →「一時的な拡張機能を読み込む」→ `dist/manifest.json`

**Chrome**: `chrome://extensions` → デベロッパーモード ON →「パッケージ化されていない拡張機能を読み込む」→ `dist-chrome/`

### ファイル構成

```
src/
├── background/
│   ├── main.js                  Firefox メインパイプライン
│   ├── sw-chrome.js             Chrome Service Worker ルーター
│   ├── api/
│   │   ├── niconico.js          ニコニコ API (JWT解析・HLS URL取得・コメント取得)
│   │   └── hls-fetcher.js       HLS セグメント取得・AES復号・プリフェッチ
│   ├── video/
│   │   ├── compositor.js        Canvas2D コメント合成パイプライン
│   │   ├── decoder.js           fMP4 パーサー・VideoDecoder 設定
│   │   └── encoder.js           VideoEncoder コーデック設定・フォールバック
│   ├── comment/
│   │   └── offscreen-renderer.js  niconicomments 用 OffscreenCanvas アダプター
│   └── muxer/
│       └── mp4-muxer-wrapper.js   mp4-muxer ラッパー
├── offscreen/
│   ├── offscreen.html           Chrome Offscreen Document
│   └── offscreen.js             Chrome メインパイプライン
├── content/
│   └── extractor.js             視聴データ抽出・Cookie付きFetch代理
├── popup/
│   ├── popup.html / .js / .css  ダウンロード UI
└── shared/
    ├── messages.js              メッセージ型定義
    └── utils.js                 ファイル名サニタイズ等
```

## ライセンス

MIT License — 詳細は [LICENSE](LICENSE) を参照。

## 謝辞

- [niconicomments](https://github.com/xpadev-net/niconicomments) (MIT License) — xpadev-net 氏によるコメント描画エンジン
- 右る氏の [あさやけもゆうやけもないんだ☆](https://www.nicovideo.jp/watch/sm39490089) — デモ動画として使用
