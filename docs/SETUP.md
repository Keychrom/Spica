# 🛠️ Spica サーバー設置・導入ガイド

> ⚠️ **現在は Alpha 版の開発中ソフトウェアです。実運用（本番環境での利用）は想定されていません。**
>
> ⚠️ **本ドキュメントに記載されている手順は、理論上可能な手順を書いているだけであり、実際に導入可能かどうかなどは一切検証していません。**

Spica の設置手順は、**2 つの構成**に分かれています。どちらか一方を選んで進めてください。

---

## 🌱 通常構成 — SQLite・1 プロセス（**迷ったらこちら**）

**[SETUP_Normal.md](SETUP_Normal.md)** — SQLite 1 ファイルと Node.js だけで動きます。追加のミドルウェアは要りません。

- **向いている規模**: 〜数十人（同時に数人）
- **必要なもの**: Node.js v22.13 以降だけ
- **内容**: システム要件 / Node.js のインストール / ソース配置とビルド / リバースプロキシ（Nginx + Let's Encrypt・Cloudflare Tunnel）/ Inbox 署名検証の確認 / 常駐化（PM2・systemd）/ メディアを R2 へ / 初期管理者の登録 / バックアップと DB メンテナンス / 自動化と監視

---

## 🐘 PostgreSQL + Redis 構成 — 複数プロセスで動かす

**[SETUP_PostgreSQL_Redis.md](SETUP_PostgreSQL_Redis.md)** — DB を PostgreSQL にし、Redis を足して複数プロセスで動かします。

- **向いている規模**: 数百人〜（**ただし作者はこの規模で運用した経験がなく、負荷の検証もしていません**）
- **必要なもの**: Node.js に加えて PostgreSQL と Redis、メディアは R2 / S3
- **内容**: PostgreSQL の用意 / SQLite からのデータ移送（`--verify` つき）/ Redis の用意 / `.env` の切り替え / 起動確認 / プロセスを増やす（PM2 cluster・systemd + nginx）/ `pg_dump` でのバックアップ / 通常構成への切り戻し

> [!TIP]
> **先に通常構成で始めて、必要になってから移すのがおすすめです。** データの移送手順を用意してあるので、
> SQLite で運用していたデータをそのまま PostgreSQL へ持っていけます。

---

## 🤔 どちらを選ぶか

| 判断の目安 | 通常構成 | PostgreSQL + Redis 構成 |
| :--- | :--- | :--- |
| 利用者は数人〜数十人 | ✅ これで十分 | 不要（オーバースペック） |
| 書き込みが混み合って待たされる | - | ✅ DB を PostgreSQL へ |
| CPU を使い切っていて待ち時間が減らない | - | ✅ Redis を入れて複数プロセスへ |
| サーバーを 2 台以上に分けたい | - | ✅（メディアは R2 / S3 が必須） |
| 運用に手間をかけたくない | ✅ 追加ミドルウェアなし | 監視対象が 2 つ増える |

なぜこの分かれ方なのか（どこで詰まるのか、次に何をすべきか）は
**[規模と安定性について (SCALE.md)](SCALE.md)** に詳しく書いています。**設置の前に一度読むことをおすすめします。**

---

## 📚 その他のドキュメント

- ⚙️ [設定リファレンス (CONFIGURATION.md)](CONFIGURATION.md) — `.env` の全項目
- 🔄 [バージョンアップ手順書 (UPGRADE.md)](UPGRADE.md) — `git pull` からの更新
- 🐘 [PostgreSQL 対応 (POSTGRESQL.md)](POSTGRESQL.md) — 設計・移行・制約の詳細
- 🔌 [Redis を使う (REDIS.md)](REDIS.md) — Redis の導入と複数プロセスの注意点
- 🌱 [規模と安定性について (SCALE.md)](SCALE.md) — 大人数に向かない理由と、今後の設計変更
- ✨ [機能一覧 (FEATURES.md)](FEATURES.md) / 🌌 [Spica の仕組み (ABOUT_SPICA.md)](ABOUT_SPICA.md)
