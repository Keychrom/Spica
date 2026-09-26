# ✦ Spica (スピカ)

> **自律分散とデータ主権のための、次世代 ActivityPub ノード**  
> Misskey や Mastodon とシームレスにつながる、軽量かつ堅牢な国産ソーシャルネットワークエンジン。
>
> ⚠️ **現在は Alpha 版の開発中ソフトウェアです。実運用（本番環境での利用）は想定されていません。**
> ⚠️ **本ドキュメントに記載されている手順は、理論上可能な手順を書いているだけであり、実際に導入可能かどうかなどは一切検証していません。**
>
> 🌱 **1 人の学生がメインで開発しているプロジェクトです。大人数でのテストができていないため、規模を大きくすると不安定になる可能性があります**（詳しくは [docs/SCALE.md](docs/SCALE.md)）。

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![ActivityPub](https://img.shields.io/badge/Protocol-ActivityPub%20(W3C)-purple.svg)](https://www.w3.org/TR/activitypub/)
[![Node.js](https://img.shields.io/badge/Node.js-v22.13%2B-green.svg)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue.svg)](https://www.typescriptlang.org/)

---

## 🌟 Spica とは？

Spica は、W3C 標準規格 **ActivityPub** に完全準拠した自律分散型SNS（Fediverse）サーバーソフトウェアです。  
世界中の Misskey、Mastodon、Firefish 等のサーバーと自由にフォロー・ノート送受信・リアクションの交換ができます。

重厚なミドルウェア（PostgreSQL や Redis など）を必要とせず、**Node.js と SQLite (FTS5)** だけで驚くほど軽量かつ高速に動作します。自宅サーバー、VPS、Raspberry Pi でも数分で自分専用の独立した主権型SNSノードを立ち上げることが可能です。

---

## ✨ 主な特徴

- 🌐 **ActivityPub / Fediverse 完全相互運用** — ノート・返信・リノート・引用・リアクション・アンケート・CW。WebFinger / NodeInfo / HTTP Signatures / リレーに対応し、配送失敗は指数バックオフで自動再送します。引っ越し（Move）と受信 Block の尊重にも対応。
- 🔑 **データ主権 ＆ マルチ認証** — マスターキー（パスワードレス）／メールアドレス＋パスワード（管理画面で切替）／パスキー（WebAuthn）。全データの JSON / ZIP エクスポートと、Mastodon・Misskey アーカイブの取り込み。
- 🔌 **サードパーティ製クライアント** — Misskey 互換 API（MiAuth ログイン・タイムライン・投稿・リアクション・通知・ドライブ）を実装。SubwayTooter や Miria などの Misskey 系クライアントから読み書きできます（ストリーミングは未対応）。
- 🗂️ **メディアとドライブ** — 画像は位置情報などを除去して WebP へ変換。S3 / Cloudflare R2 対応（ローカル保存も可）。アップロードは「ドライブ」で一覧・削除・容量管理でき、ffmpeg があれば動画サムネイルも自動生成します。
- 🔔 **通知とリアルタイム更新** — SSE による即時配信と PWA / Web Push。通知は**種類別に ON/OFF** できます（フォロー・返信・メンション・リアクション・リノート・アンテナ・引っ越し）。
- 🔒 **3段階の公開範囲** — 公開（連合配信）／ローカル限定／フォロワー限定。※**DM（1対1のメッセージ）は方針として実装していません**（理由は[こちら](#-dm1対1のメッセージ機能を実装しない方針)）。
- 🛡️ **セキュリティとモデレーション** — 署名検証（strict）・SSRF 対策・IP 単位のレート制限・ワードフィルター・鍵アカウント・通報（`Flag` 転送）・ドメインブロック。任意で Authorized Fetch（署名必須モード）。
- 🛠️ **1人でも回せる運用** — `npm run db:maintenance` でリモート投稿の整理・孤立メディアの削除・VACUUM・バックアップまで一括。既定はドライランで安全に確認できます。

> 📖 **すべての機能は [docs/FEATURES.md](docs/FEATURES.md) にまとめています。**（投稿とタイムライン／メディアとドライブ／通知／認証／連合／セキュリティ／モデレーション／運用）

---

## 🚀 クイックスタート (ローカル起動)

### 前提条件
- **Node.js**: v22.13.0 以上（v24 推奨）。`node:sqlite` を使うため、v22.5〜v22.12 / v23.0〜v23.3 では `--experimental-sqlite` が必要で、v20 以前では動作しません
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

Spicaの思想・アーキテクチャ、本番運用やサーバー設置に関する詳しいガイドは、以下のドキュメントをご覧ください：

- ✨ **[機能一覧 (docs/FEATURES.md)](docs/FEATURES.md)**
  - 投稿・タイムライン、メディアとドライブ、通知、認証、連合、セキュリティ、モデレーション、運用の全機能
  - 実装していない機能（DM 等）とその方針
- 🌌 **[Spicaの仕組みと目指しているもの (docs/ABOUT_SPICA.md)](docs/ABOUT_SPICA.md)**
  - 自立分散型ソーシャルネットワーク（Fediverse / ActivityPub）の仕組み
  - 巨大テックの中央集権からの解放とデータ主権の理念
  - 超軽量・自己完結型アーキテクチャ、暗号署名、パスキー生体認証、PWA
- 🛠️ **[サーバー設置・導入ガイド (docs/SETUP.md)](docs/SETUP.md)** — 2 つの構成から選べます
  - 🌱 **[通常構成 (docs/SETUP_Normal.md)](docs/SETUP_Normal.md)** — SQLite・1 プロセス（〜数十人。**迷ったらこちら**）
  - 🐘 **[PostgreSQL + Redis 構成 (docs/SETUP_PostgreSQL_Redis.md)](docs/SETUP_PostgreSQL_Redis.md)** — 複数プロセス（数百人〜）
  - Linux / Ubuntu サーバーへのセットアップ手順
  - Nginx リバースプロキシ・SSL証明書（Let's Encrypt）の設定
  - Cloudflare Tunnel での公開手順
  - Cloudflare R2 / S3 ストレージの設定方法
  - PM2 / systemd による自動起動・常駐化
  - DB メンテナンスとバックアップ（`npm run db:maintenance` / `npm run db:pg:backup`）
- 🔄 **[バージョンアップ手順書 (docs/UPGRADE.md)](docs/UPGRADE.md)**
  - `git pull` からの安全なアップデート手順
  - ゼロダウンタイム再起動とマイグレーション
- ⚙️ **[設定リファレンス (docs/CONFIGURATION.md)](docs/CONFIGURATION.md)**
  - `.env` で設定可能なすべてのパラメータの詳細解説
- 🔌 **[Redis を使う (docs/REDIS.md)](docs/REDIS.md)**
  - 複数プロセスで動かすための任意依存（レート制限・リアルタイム更新・設定の反映の共有）
  - 既定では使いません（未設定なら今までどおりインメモリで動きます）
- 🌱 **[規模と安定性について (docs/SCALE.md)](docs/SCALE.md)**
  - **このプロジェクトは 1 人の学生がメインで開発しています。大人数でのテストはできていません**
  - なぜ大人数に向かないのか（単一プロセス・ジョブキューなし・SQLite 既定など）と、規模ごとの見通し
  - 大人数で使う場合の緩和策と、まだ実装されていないこと

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
├── client/               # フロントエンド (React 19 / Vite / Tailwind CSS)
│   ├── src/              # SPA クライアント UI (タイムライン, 管理画面, PWA)
│   └── public/           # PWA マニフェスト, サービスワーカー, ロゴアセット
├── docs/                 # 公式セットアップ・運用ドキュメント
└── scripts/              # テスト・検証用スクリプト群
```

---

## 🛡️ セキュリティとプライバシー

- **HTTP Signature 検証の強制**: 受信した Activity は、署名鍵の持ち主と `actor` の一致・ボディの Digest 一致・署名の鮮度をすべて検証し、失敗したものは **401 で拒否**します（`INBOX_SIGNATURE_MODE=strict`、既定）。なりすまし投稿や改ざん・リプレイを防ぎます。署名鍵の取得先は SSRF 対策としてプライベートアドレス・内部ホスト名を拒否します。
- **パスワードレス**: パスワードの平文やハッシュの漏洩リスクがありません。
- **データ主権**: ユーザーが希望すればいつでも自身のアカウントと過去投稿を連合先（Fediverse）を含めて完全削除可能。
- **データベース**: 既定は SQLite（追加ミドルウェア不要。`node:sqlite` の同期 API を 1 接続で使います）。大規模化したときのための PostgreSQL 対応は `DB_DRIVER=postgres DATABASE_URL=...` で有効になり、設計・移行手順・制約は [docs/POSTGRESQL.md](docs/POSTGRESQL.md) にまとめています（既定は SQLite のまま。データ層は非同期化済みで、どちらのドライバも同じコードで動きます）。
- **機密情報の保護**: 本番環境の `.env` や SQLite データベースファイルは Git 追跡から厳重に除外されています。さらに `npm run check:secrets` が秘密鍵・API トークン・`.env`・SQLite の混入を検出し、`npm install` 時に有効になる git フックが検出時はコミットを中止します。
- **プライバシー（画像プロキシ）**: リモートのアイコンや添付画像は既定でこのノード経由で配信し、閲覧者の IP や User-Agent を相手サーバーに渡しません。

---

## 🚫 DM（1対1のメッセージ機能）を実装しない方針

Spica は、**ダイレクトメッセージ（DM / Misskey 等でいう `specified` 公開範囲）を意図的に実装していません**。「まだ未対応」ではなく、**方針として提供しません**。

理由は法規制です。1対1のメッセージ機能を提供すると、ノードの運営が「他人の通信を媒介する事業」と評価されうるため、運営者（個人であっても）が電気通信事業法上の義務を負うおそれがあります。

- 電気通信事業の**届出**義務
- **通信の秘密**の保持
- **秘密の漏洩防止**義務

これらは、趣味で建てて自分の PC で運用する「手のひらサイズのノード」という Spica の前提と両立しません。そのため Spica は、公開範囲を **公開（連合配信）／ローカル限定／フォロワー限定** の3段階に限定し、DM は実装対象外としています。

利用者・運営者のみなさまへ:

- **フォロワー限定は DM ではありません。** 承認したフォロワー全員が閲覧でき、連合先のフォロワーの Inbox にも配信されます。1対1の内緒の会話を想定したものではありません。
- ノード運営者（サーバー管理者）はデータベースを直接参照できる立場にあります。**運営者に見られたくない内容は投稿しないでください。**
- 他の Fediverse サーバーに DM 機能があっても、Spica のアカウント宛ての1対1メッセージは送受信できません。

> ※ 上記は本プロジェクトの方針を説明するものであり、法的助言ではありません。個別の運用判断については、必要に応じて専門家にご確認ください。

---

## 📄 ライセンス

本プロジェクトは [MIT License](LICENSE) の下で公開されています。
