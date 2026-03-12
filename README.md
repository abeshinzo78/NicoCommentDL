# NicoCommentDL

ニコニコ動画のコメント付き動画をダウンロードするためのブラウザ拡張機能です。  
高パフォーマンスなコメント描画ライブラリ [niconicomments](https://github.com/xpadev-net/niconicomments) を使用して、動画とコメントを一つのMP4ファイルとして合成・保存します。

[![zread](https://img.shields.io/badge/Ask_Zread-_.svg?style=flat&color=00b0aa&labelColor=000000&logo=data%3Aimage%2Fsvg%2Bxml%3Bbase64%2CPHN2ZyB3aWR0aD0iMTYiIGhlaWdodD0iMTYiIHZpZXdCb3g9IjAgMCAxNiAxNiIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj4KPHBhdGggZD0iTTQuOTYxNTYgMS42MDAxSDIuMjQxNTZDMS44ODgxIDEuNjAwMSAxLjYwMTU2IDEuODg2NjQgMS42MDE1NiAyLjI0MDFWNC45NjAxQzEuNjAxNTYgNS4zMTM1NiAxLjg4ODEgNS42MDAxIDIuMjQxNTYgNS42MDAxSDQuOTYxNTZDNS4zMTUwMiA1LjYwMDEgNS42MDE1NiA1LjMxMzU2IDUuNjAxNTYgNC45NjAxVjIuMjQwMUM1LjYwMTU2IDEuODg2NjQgNS4zMTUwMiAxLjYwMDEgNC45NjE1NiAxLjYwMDFaIiBmaWxsPSIjZmZmIi8%2BCjxwYXRoIGQ9Ik00Ljk2MTU2IDEwLjM5OTlIMi4yNDE1NkMxLjg4ODEgMTAuMzk5OSAxLjYwMTU2IDEwLjY4NjQgMS42MDE1NiAxMS4wMzk5VjEzLjc1OTlDMS42MDE1NiAxNC4xMTM0IDEuODg4MSAxNC4zOTk5IDIuMjQxNTYgMTQuMzk5OUg0Ljk2MTU2QzUuMzE1MDIgMTQuMzk5OSA1LjYwMTU2IDE0LjExMzQgNS42MDE1NiAxMy43NTk5VjExLjAzOTlDNS42MDE1NiAxMC42ODY0IDUuMzE1MDIgMTAuMzk5OSA0Ljk2MTU2IDEwLjM5OTlaIiBmaWxsPSIjZmZmIi8%2BCjxwYXRoIGQ9Ik0xMy43NTg0IDEuNjAwMUgxMS4wMzg0QzEwLjY4NSAxLjYwMDEgMTAuMzk4NCAxLjg4NjY0IDEwLjM5ODQgMi4yNDAxVjQuOTYwMUMxMC4zOTg0IDUuMzEzNTYgMTAuNjg1IDUuNjAwMSAxMS4wMzg0IDUuNjAwMUgxMy43NTg0QzE0LjExMTkgNS42MDAxIDE0LjM5ODQgNS4zMTM1NiAxNC4zOTg0IDQuOTYwMVYyLjI0MDFDMTQuMzk4NCAxLjg4NjY0IDE0LjExMTkgMS42MDAxIDEzLjc1ODQgMS42MDAxWiIgZmlsbD0iI2ZmZiIvPgo8cGF0aCBkPSJNNCAxMkwxMiA0TDQgMTJaIiBmaWxsPSIjZmZmIi8%2BCjxwYXRoIGQ9Ik00IDEyTDEyIDQiIHN0cm9rZT0iI2ZmZiIgc3Ryb2tlLXdpZHRoPSIxLjUiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIvPgo8L3N2Zz4K&logoColor=ffffff)](https://zread.ai/abeshinzo78/nicocommentDL)

[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/abeshinzo78/nicocommentDL)


> [!IMPORTANT]
> **現在は Firefox 版のみを公開しています。**  
> Chrome 版は現在開発中です。

## 主な機能
- **コメント付き動画の保存** - 視聴中の動画と流れているコメントを合成して、一つの動画ファイルとしてダウンロードします。
- **高精度な合成** - [niconicomments](https://github.com/xpadev-net/niconicomments) により、公式プレイヤーにかなり近いコメント描画を再現します。
- **高速な処理** - ブラウザ上でのストリーミング処理により、長時間動画も効率的に処理しメモリ負担がほとんどないのが特徴です。

## 実際にダウンロードしたもの

https://github.com/user-attachments/assets/ac07223a-1949-4e3e-9f3f-bd6026d50a83

# インストール方法

[releases](https://github.com/abeshinzo78/NicoCommentDL/releases/)から最新版のxpiファイルをダウンロードしてください。

## 開発版のインストール方法

### 1. リポジトリをダウンロード
このリポジトリをクローンするか、ZIPでダウンロードして解凍してください。

```bash
git clone https://github.com/abeshinzo78/nicocommentDL.git
cd nicocommentDL
```

### 2. 依存関係のインストール
```bash
npm install
```

### 3. ビルド
```bash
npm run build
```

### 4. ブラウザに読み込む (Firefox)
1. Firefox のアドレスバーに `about:debugging#/runtime/this-firefox` を入力します。
2. 「一時的な拡張機能を読み込む...」をクリックします。
3. プロジェクトフォルダ内の `manifest.json` を選択します。

# 使い方
1. ニコニコ動画の各動画ページを開きます。
2. 拡張機能のアイコンをクリックしてポップアップを開きます。
3. 合成・ダウンロードを開始します。

## 開発
改造大歓迎です！自由にフォークして自分好みの機能を追加してください。

### テストの実行
```bash
npm test
```

## ライセンス
このプロジェクトは **MIT License** のもとで公開されています。詳細については [LICENSE](LICENSE) ファイルを参照してください。

## 謝辞

以下のプロジェクト・ライブラリのコードを使用、参考にさせていただいています。xpadev-net氏に敬意を表します。
- [niconicomments](https://github.com/xpadev-net/niconicomments) (MIT License) - コメント描画エンジン

  また右る氏の　[あさやけもゆうやけもないんだ☆](https://www.nicovideo.jp/watch/sm39490089) を説明として使わせていただきました。
  右る氏に敬意を表します。


