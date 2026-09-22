# 🐘 PostgreSQL 対応（設計と移行手順）

> [!IMPORTANT]
> **実装状況: 未実装。** この文書は「PostgreSQL で建てる / SQLite から移行する」ときに何をするかを先に確定させた**設計書**です。
> ここに書いた手順・コマンドは、実装が入るまで**そのままでは動きません**（今は SQLite で動きます）。
> 「動く手順」として書くには先に実装が必要で、動かない手順を動くように見せると事故のもとになるため、状態を明示しています。
>
> | 項目 | 状態 |
> | :--- | :--- |
> | 移植コストの計測（`npm run db:port-report`） | ✅ 実装済み |
> | スキーマの対応表・手順の確定 | ✅ この文書 |
> | PostgreSQL ドライバ＋スキーマ | ⬜ 未着手（要 PostgreSQL 環境） |
> | データ移送ツール（SQLite → PG） | ⬜ 未着手 |
> | 既存テストスイートの PG 実行 | ⬜ 未着手 |

---

## 📏 1. なぜ「設定を変えるだけ」ではないのか

`npm run db:port-report` が `server/src` の SQL リテラルだけを数えた結果です（2026-09-22 時点）。

| 項目 | 件数 | 分類 |
| :--- | ---: | :--- |
| SQL リテラル | 698 本 | — |
| `db.prepare(...)` 呼び出し | 573 | 同期 API |
| `db.exec(...)` 呼び出し | 32 | 同期 API |
| プレースホルダ `?` | 1,064 | 置換（`$1, $2` へ） |
| 真偽値の `0/1` 比較 | 40 | 置換（BOOLEAN / SMALLINT の統一） |
| `changes` / `last_insert_rowid` | 22 | 置換（`RETURNING` へ） |
| FTS5（`posts_fts` / `MATCH` / trigram） | 18 | **設計変更**（検索基盤の差し替え） |
| `PRAGMA` | 13 | 置換 |
| 一時テーブル（`CREATE TEMP`） | 9 | 置換 |
| `INSERT OR IGNORE` / `REPLACE` | 7 | 置換（`ON CONFLICT` へ） |
| `datetime()` 系 | 5 | 置換 |
| `VACUUM` / `wal_checkpoint` | 5 | **設計変更**（運用そのものが変わる） |

素朴にソース全体を正規表現で走査すると JavaScript の三項演算子の `?`、`str.match(`、`new Date(` まで拾ってしまうため、この道具は **`db.prepare` / `db.exec` に渡している文字列を切り出してから**数えています。再計測は `npm run db:port-report`（全件表示は `--list`、JSON は `--json`）でどうぞ。

> [!NOTE]
> 「置換」と分類したものも、単純な置換では終わりません。理由は次の節の同期 API の問題です。

---

## 🧵 2. 最大の論点: 同期 API をどうするか

Spica は `node:sqlite` の**同期 API** をそのまま使っています。ブロックする代わりに単純で、1 プロセス・1 ファイルの SQLite と相性が良い設計です。PostgreSQL のクライアントは非同期なので、ここで道が 2 つに分かれます。

### 案A: データ層を非同期化する（本筋）

SQL をリポジトリ層（`db/*` のモジュール）へ集約し、呼び出しを `await` に変えていきます。

- 利点: 正攻法。PG のコネクションプールを活かせ、テストもしやすい。将来の変更に耐える。
- 欠点: 573 箇所に加えて、その呼び出し元（ルートハンドラ、サービス、スケジューラ、メンテナンス CLI）まで連鎖する。SSE や同期前提の処理を一つずつ見直す必要がある。
- 規模感: **数週間規模。** 一度にやると壊れるので、まずリポジトリ層を切って SQLite のまま緑を保ち、その後でドライバを差し替える段階移行が安全。

### 案B: 同期ファサード（worker thread + `Atomics.wait`）

別スレッドに `pg` のプールを持たせ、SharedArrayBuffer で同期呼び出しに見せかけます。573 箇所を変えずに済む可能性があります。

- 利点: 既存コードに触れずに PG で動かせる。移行用の足場としては最短。
- 欠点: 1 クエリごとにスレッド間の待ちが入る。実装が繊細で、間違えるとハングする（タイムアウトとトランザクションの接続固定が必須）。
- 評価: 「まず動かして移行データを作る」ための道具としては有効だが、**恒久保守に耐えるのは案A**。

> [!TIP]
> 推奨は **案A を段階的に**。案B は移行専用の一時的な足場としてのみ許容する、という線引きが現実的です。

---

## 🗺️ 3. スキーマの対応表

| SQLite（現状） | PostgreSQL | 備考 |
| :--- | :--- | :--- |
| `TEXT`（ISO 8601 の日時） | `TIMESTAMPTZ` | 文字列比較でも動くが、期間の計算は `interval` へ |
| `INTEGER` の `0/1`（真偽） | `BOOLEAN`（推奨）または `SMALLINT` | 40 箇所の比較を書き換える |
| `INTEGER`（件数・サイズ） | `BIGINT` | |
| `REAL`（duration など） | `DOUBLE PRECISION` | |
| `TEXT PRIMARY KEY`（アプリ側採番） | `TEXT PRIMARY KEY` | 変更不要（UUID / タイムスタンプ採番） |
| FTS5 trigram（`posts_fts`） | `pg_trgm`（GIN）または `tsvector`、外部検索 | 日本語は trigram 相当が必要。`pg_trgm` の `%` + `ILIKE` が現実的 |
| `datetime('now')` | `now()` / `CURRENT_TIMESTAMP` | |
| `PRAGMA foreign_keys = ON` | 標準で有効 | 指定不要 |
| `PRAGMA journal_mode = WAL` | 不要（MVCC） | |
| `VACUUM` / `wal_checkpoint` | autovacuum / `CHECKPOINT` | **手順そのものが不要になる** |
| `VACUUM INTO`（バックアップ） | `pg_dump` / `pg_basebackup` | `db:maintenance` の④に相当 |
| `INSERT OR IGNORE` | `ON CONFLICT DO NOTHING` | |
| `INSERT OR REPLACE` | `ON CONFLICT (key) DO UPDATE SET ...` | 競合キーの明示が必要 |
| `changes`（影響行数） | `RETURNING` / rowCount | |

---

## 🚀 4. 手順A: 最初から PostgreSQL で建てる

> [!WARNING]
> 以下のコマンドは**まだ存在しません**（実装予定）。手順の確定版としてここに書いています。

1. PostgreSQL 16+ を用意し、DB とロールを作る。日本語検索を使うなら拡張も入れる。
   ```sql
   CREATE DATABASE spica;
   CREATE EXTENSION IF NOT EXISTS pg_trgm;
   ```
2. `.env` に接続先を設定する（`DB_PATH` は使わない）。
   ```
   DATABASE_URL=postgres://spica:password@127.0.0.1:5432/spica
   ```
3. スキーマを適用する（実装予定）。
   ```bash
   npm run db:pg:init
   ```
4. 起動する。
   ```bash
   npm run build && npm start
   ```
5. 動作確認: `GET /health` が 200、タイムライン・検索・配送・管理画面が動くこと。既存テストを PG で通す（実装予定）。
   ```bash
   npm run test:pg
   ```
6. バックアップは `pg_dump` の cron に置き換える（`db:maintenance` の SQLite 前提部分は使わない）。保持期間削除・方針適用（②③⑤に相当）はアプリ側の処理なのでそのまま使える想定。
7. `VACUUM` 相当の作業は不要（autovacuum）。「サーバーを止めて VACUUM」という現在の運用項目が**1 つ消える**のは PG 化の実利です。

---

## 🔄 5. 手順B: SQLite から PostgreSQL へ移行する

> [!IMPORTANT]
> **エクスポート / インポートは使いません。** 現在のエクスポートはユーザー単位のアーカイブで、ノードの全データは移りません（付録参照）。
> ノード移行は**テーブル単位の移送**で行います。

0. 前提: 移行先の PG ノードを手順Aで建てておく（スキーマは同一）。
1. **書き込みを止める**: 告知のうえでサービスを停止する。SQLite は単一ファイルなので、止めた時点のスナップショットがそのまま移行元になる。
2. **控えを取る**: `npm run db:maintenance -- --backup-only`
3. **移送する**（実装予定）: 外部キーの依存順（`users` → `remote_actors` → `posts` → `follows` → …）に、1 万件ずつバッチ INSERT する。中断しても再開できるよう進捗を記録する。
   ```bash
   npm run db:pg:migrate -- --from data_astrabit.sqlite --to "$DATABASE_URL"
   ```
4. **検証する**: テーブルごとの行数一致と、主要テーブルのサンプル照合（`--verify`）。FTS 索引は PG 側で再構築する。
5. **起動する**: `DATABASE_URL` を設定して起動し、`/health`・タイムライン・検索・配送・メンテナンスを確認する。
6. **切り戻せるようにしておく**: SQLite のファイルは無傷なので、`.env` を戻して再起動すれば元に戻る。ただし移行中に PG 側で受けた書き込みは失われるため、切り替えは短時間で行い、書き込みを止めた状態で実施する。
7. **後片付け**: 問題がなければ SQLite ファイルは当面保管する（すぐには消さない）。

移行の対象外・別扱い:

| 対象 | 扱い |
| :--- | :--- |
| メディア実体（`data/uploads`） | DB ではなくファイル。S3 / R2 にある場合はそのまま |
| 画像プロキシのキャッシュ | 再生成されるので移送しない |
| FTS 索引 | PG 側で再構築する |
| セッション | 移行後に再ログインを促すのが安全 |

---

## ✅ 6. 移植の完了条件（検証ゲート）

- 既存の `npm run test:*` が **SQLite と PostgreSQL の両方で緑**（同じテストを両方で回す）
- `npm run db:port-report` の `redesign` 項目が 0 になっている
- 起動・停止・メンテナンス・バックアップ・復元の手順が、この文書どおりに実行できる

---

## 🚫 7. やらないこと

- **二重対応の恒久保守はしない。** SQLite と PG の両方で動くコードを維持し続けると、テストも運用も 2 倍になる。PG 対応を入れるなら「どちらかを選ぶ」形にし、テストだけ両方で回す。
- **案B（同期ファサード）を常用しない。** 移行の足場としてのみ許容する。

---

## 📌 8. 現状の推奨（2026-09 時点）

| 規模の目安 | 推奨 |
| :--- | :--- |
| 数十人のアクティブ | **SQLite のままで問題ない。** 伸びてきたら保持期間・索引方針・メディア外部化（S3/R2）で調整する |
| 数百人の日次アクティブ / 書き込み競合が見え始めた | この文書の手順で PostgreSQL へ移行する |
| 数千人以上 | Mastodon / Misskey が適所（Spica の設計思想とは別の用途） |

---

## 📎 付録: エクスポート / インポートの範囲（移行の代替にならない理由）

- **エクスポート**（`server/src/exportService.ts`）は**ユーザー単位**のアーカイブ。含まれるのは `users` / `posts` / `announces` / `reactions` / `bookmarks` / `follows`。リスト・アンテナ・ミュート / ブロック・通知設定・メディア実体・サーバー設定（ルール、リレー、ロール、ブロック済みドメインなど）は含まれない。
- **インポート**（`server/src/importService.ts`）は Mastodon / Misskey のアーカイブから**投稿（と添付）**を取り込むもの。

つまり、これらは「ユーザーが別ノードへ引っ越す」ための道具であって、「ノードごと DB を移す」ための道具ではありません。ノード移行はテーブル単位の移送（手順B）が必要です。
