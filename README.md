# NicoCommentDL

ニコニコ動画のコメント付き動画をダウンロードするためのブラウザ拡張機能です。  
高パフォーマンスなコメント描画ライブラリ [niconicomments](https://github.com/xpadev-net/niconicomments) を使用して、動画とコメントを一つのMP4ファイルとして合成・保存します。

> [!IMPORTANT]
> **現在は Firefox 版のみを公開しています。**  
> Chrome 版は現在開発中です。

## 主な機能
- **コメント付き動画の保存** - 視聴中の動画と流れているコメントを合成して、一つの動画ファイルとしてダウンロードします。
- **高画質・高精度な合成** - [niconicomments](https://github.com/xpadev-net/niconicomments) により、公式プレイヤーにかなり近いコメント描画を再現します。
- **高速な処理** - ブラウザ上でのストリーミング処理により、長時間動画も効率的に処理しメモリ負担がほとんどないのが特徴です。

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

また、以下のプロジェクト・ライブラリのコードを使用、参考にさせていただいています。xpadev-net氏に敬意を表します。
- [niconicomments](https://github.com/xpadev-net/niconicomments) (MIT License) - コメント描画エンジン


