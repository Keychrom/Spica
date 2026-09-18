# ✦ Spica (スピカ)

> **自律分散とデータ主権のための、次世代 ActivityPub ノード**  
> Misskey や Mastodon とシームレスにつながる、軽量かつ堅牢な国産ソーシャルネットワークエンジン。

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![ActivityPub](https://img.shields.io/badge/Protocol-ActivityPub%20(W3C)-purple.svg)](https://www.w3.org/TR/activitypub/)
[![Node.js](https://img.shields.io/badge/Node.js-v20%2B-green.svg)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue.svg)](https://www.typescriptlang.org/)

---

## 🌟 Spica とは？

Spica は、W3C 標準規格 **ActivityPub** に完全準拠した自律分散型SNS（Fediverse）サーバーソフトウェアです。  
世界中の Misskey、Mastodon、Firefish 等のサーバーと自由にフォロー・ノート送受信・リアクションの交換ができます。

重厚なミドルウェア（PostgreSQL や Redis など）を必要とせず、**Node.js と SQLite (FTS5)** だけで驚くほど軽量かつ高速に動作します。自宅サーバー、VPS、Raspberry Pi でも数分で自分専用の独立した主権型SNSノードを立ち上げることが可能です。

---

## ✨ 主な特徴

- 🌐 **ActivityPub / Fediverse 完全相互運用**
  - ノート作成、返信、リノート、引用、メンション、ハッシュタグ、CW（閲覧注意）、アンケート投票
  - リモートフォロー、フォロワー管理、WebFinger、NodeInfo 2.1、公開鍵署名（HTTP Signatures）
  - 連合リレー（YUKARI、Akkoma等）への接続と送受信に対応
- 🔑 **データ主権 ＆ パスワードレス認証（マスターキー）**
  - 個人情報（メールアドレス・電話番号など）を一切収集しません。
  - アカウント登録時に暗号学的に安全な **マスターキー** が発行され、ユーザー自身がアカウントの完全な所有権を持ちます。
- 📦 **ワンクリック データエクスポート**
  - 「自分のデータは自分のもの」。過去の全投稿、フォロー・フォロワー一覧、ブックマーク、リアクション履歴をいつでも **JSON または ZIP アーカイブ** 形式で一括ダウンロードできます。
- 🔍 **SQLite FTS5 高速日本語全文検索**
  - ハッシュタグだけでなく、過去の膨大な投稿本文から目的のキーワードを瞬時に全文検索できます。
- 🔔 **PWA ＆ Web Push 通知**
  - ホーム画面に追加してネイティブアプリのように利用可能。
  - ブラウザやアプリを閉じていても、自分宛ての返信やリアクションを端末の通知欄へリアルタイムにお届けします。
- ☁️ **S3 / Cloudflare R2 互換オブジェクトストレージ連携**
  - 画像や動画などの大容量メディアは、Cloudflare R2 や Amazon S3 などの外部ストレージへ直接保存・配信可能。ローカル保存へのフォールバックも完備。
- 📜 **サーバールール設定 ＆ 新規登録同意フロー**
  - Misskey スタイルのサーバールール、利用規約、プライバシーポリシーを管理画面から自由に設定可能。
  - 新規登録時に丁寧な同意モーダルを表示し、健全なコミュニティ運営をサポート。

---

## 🚀 クイックスタート (ローカル起動)

### 前提条件
- **Node.js**: v20.0.0 以上 (v22 / v24 推奨)
- **npm**: v9.0.0 以上

### 1. リポジトリのクローン
```bash
git clone https://github.com/Keychrom/Spica.git
cd Spica
```

### 2. 依存パッケージのインストール
```bash
npm install
```

### 3. 設定ファイルの準備
```bash
cp .env.example .env
```
※ローカル開発の場合は、デフォルト設定のまま利用可能です。

### 4. 開発サーバーの起動
```bash
npm run dev
```
起動後、ブラウザで [http://localhost:5173](http://localhost:5173) にアクセスしてください。

---

## 📚 ドキュメント・マニュアル

本番運用やサーバー設置に関する詳しいガイドは、以下のドキュメントをご覧ください：

- 🛠️ **[サーバー設置・導入ガイド (docs/SETUP.md)](docs/SETUP.md)**
  - Linux / Ubuntu サーバーへのセットアップ手順
  - Nginx リバースプロキシ・SSL証明書（Let's Encrypt）の設定
  - Cloudflare Tunnel での公開手順
  - Cloudflare R2 / S3 ストレージの設定方法
  - PM2 / systemd による自動起動・常駐化
- 🔄 **[バージョンアップ手順書 (docs/UPGRADE.md)](docs/UPGRADE.md)**
  - `git pull` からの安全なアップデート手順
  - ゼロダウンタイム再起動とマイグレーション
- ⚙️ **[設定リファレンス (docs/CONFIGURATION.md)](docs/CONFIGURATION.md)**
  - `.env` で設定可能なすべてのパラメータの詳細解説

---

## 🏗️ アーキテクチャ

```
Spica/
├── server/               # バックエンド (Node.js / Express / TypeScript)
│   ├── src/
│   │   ├── routes/       # ActivityPub, WebFinger, REST API, Admin ルーティング
│   │   ├── db.ts         # SQLite データベース層 (FTS5 全文検索, マイグレーション)
│   │   ├── activitypub.ts# 連合通信・HTTP署名検証・配信エンジン
│   │   ├── storage.ts    # S3 / Cloudflare R2 / ローカルストレージ
│   │   ├── pushService.ts# Web Push (VAPID) 通知サービス
│   │   └── exportService.ts # データエクスポート (JSON / ZIP)
│   └── package.json
├── client/               # フロントエンド (React 18 / Vite / Tailwind CSS)
│   ├── src/              # SPA クライアント UI (タイムライン, 管理画面, PWA)
│   └── public/           # PWA マニフェスト, サービスワーカー, ロゴアセット
├── docs/                 # 公式セットアップ・運用ドキュメント
└── scripts/              # テスト・検証用スクリプト群
```

---

## 🛡️ セキュリティとプライバシー

- **パスワードレス**: パスワードの平文やハッシュの漏洩リスクがありません。
- **データ主権**: ユーザーが希望すればいつでも自身のアカウントと過去投稿を連合先（Fediverse）を含めて完全削除可能。
- **機密情報の保護**: 本番環境の `.env` や SQLite データベースファイルは Git 追跡から厳重に除外されています。

---

## 📄 ライセンス

本プロジェクトは [MIT License](LICENSE) の下で公開されています。
