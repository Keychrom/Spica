# 🐘 PostgreSQL 対応（現状と手順）

> [!IMPORTANT]
> **アプリ本体はまだ PostgreSQL では動きません。** 実装済みなのは「スキーマ」「データ移送」「検証」までで、
> Spica 自身が PostgreSQL に接続する部分（ドライバ）は未着手です。今の Spica は SQLite で動きます。
>
> | 項目 | 状態 | 使い方 |
> | :--- | :--- | :--- |
> | 移植コストの計測 | ✅ 実装済み | `npm run db:port-report` |
> | PostgreSQL スキーマの生成 | ✅ 実装済み | `npm run db:pg:schema` |
> | スキーマの適用 | ✅ 実装済み | `npm run db:pg:init -- --dsn "$DATABASE_URL"` |
> | SQLite → PostgreSQL のデータ移送 | ✅ 実装済み | `npm run db:pg:migrate -- --from ... --dsn ... --verify` |
> | PG 上での動作検証（スキーマ・移送・検索・トリガー） | ✅ 実装済み | `TEST_DATABASE_URL=... npm run test:pg-port` |
> | **アプリ本体のドライバ（PG で起動する）** | ⬜ 未着手 | — |
> | アプリのテストスイートを PG で実行 | ⬜ 未着手 | — |

---

## 📊 実測値（2026-09-22、PostgreSQL 18.6 / Windows）

`npm run db:port-report` による計測（`server/src` の SQL リテラルだけを数える）:

| 項目 | 件数 | 分類 |
| :--- | ---: | :--- |
| SQL リテラル | 698 本 | — |
| `db.prepare(...)` 呼び出し | 573 | 同期 API |
| プレースホルダ `?` | 1,064 | 置換（`$1, $2` へ） |
| `changes` / `last_insert_rowid` | 22 | 置換（`RETURNING` へ） |
| FTS5（`posts_fts` / `MATCH`） | 18 | **設計変更**（検索基盤の差し替え） |
| `PRAGMA` | 13 | 置換 |
| 一時テーブル | 9 | 置換 |
| `INSERT OR IGNORE` / `REPLACE` | 7 | 置換（`ON CONFLICT` へ） |
| `datetime()` 系 | 5 | 置換 |
| `VACUUM` / `wal_checkpoint` | 5 | **設計変更**（運用が変わる） |

実データ（ライブノードのスナップショット）での移送結果:

| 項目 | 結果 |
| :--- | :--- |
| 移送した行数 | **187,072 行**（42 テーブル。`posts` 178,026 行を含む） |
| 所要時間 | **12.1 秒**（1,000 行ずつのバッチ INSERT） |
| 検証 | **全テーブルで行数と内容の要約が一致** |
| PostgreSQL のサイズ | 172 MB（SQLite のスナップショットは 320 MB。SQLite 側は未 VACUUM の空きページを含む） |
| タイムライン相当のクエリ | 9 ms（リモート投稿 18 万行から最新 50 件） |
| 期間指定の件数集計 | 139 ms（`published_at` で 18 万行を走査） |
| 日本語の部分一致検索 | pg_trgm の GIN 索引で動作（ローカル投稿の索引のみ） |

---

## 🧵 1. なぜ「設定を変えるだけ」ではないのか

最大の論点は構文の置換ではなく**同期 API**です。Spica は `node:sqlite` の同期 API（573 箇所）をそのまま使っており、
PostgreSQL のクライアントは非同期なので、ここで道が 2 つに分かれます。

### 案A: データ層を非同期化する（本筋）

SQL をリポジトリ層へ集約し、呼び出しを `await` に変えていく。

- 利点: 正攻法。PG のコネクションプールを活かせ、テストもしやすい。
- 欠点: 573 箇所に加えて呼び出し元（ルートハンドラ、サービス、スケジューラ、CLI）まで連鎖する。**数週間規模。**
- 進め方: まずリポジトリ層を切って SQLite のまま緑を保ち、その後でドライバを差し替える。

### 案B: 同期ファサード（worker thread + `Atomics.wait`）

別スレッドに `pg` のプールを持たせ、同期呼び出しに見せかける。573 箇所を変えずに済む可能性がある。

- 利点: 既存コードに触れずに PG で動かせる。
- 欠点: 1 クエリごとにスレッド間待ちが入る。実装が繊細で、間違えるとハングする。
- 評価: 移行用の一時的な足場としては有効だが、**恒久保守に耐えるのは案A**。

> [!TIP]
> 推奨は **案A を段階的に**。今回の作業（スキーマ・移送）はどちらの案でも必要になる部分なので、先に済ませてあります。

---

## 🗺️ 2. スキーマの対応（実装済み・生成方式）

**PostgreSQL の DDL は手で書かず、`server/src/db.ts` の migrations（SQLite）から生成します。**
二重管理を避けるためで、スキーマの正は今までどおり SQLite 側です。

```bash
npm run db:pg:schema          # server/src/db/schema.pg.sql を生成
npm run db:pg:schema -- --check   # 生成物が最新かを確認（CI 向け）
```

生成時の変換:

| SQLite | PostgreSQL | 理由 |
| :--- | :--- | :--- |
| `INTEGER` | **`BIGINT`** | SQLite の INTEGER は 64bit。ミリ秒タイムスタンプ（1.79e12 など）が入る列があり、`INTEGER` では範囲外になる |
| 真偽値（`INTEGER` の `0/1`） | `BIGINT` のまま | 0/1 を維持するので、アプリ側の `= 1` 比較を書き換えずに済む |
| `TEXT`（ISO 8601 日時） | `TEXT` のまま | 比較・ソートはそのまま動く。期間計算は移送後もアプリ側の文字列比較 |
| `REAL` / `BLOB` | `DOUBLE PRECISION` / `BYTEA` | |
| FTS5 仮想テーブル（trigram） | 通常テーブル + `GIN (content gin_trgm_ops)` | 日本語の部分一致は `ILIKE '%…%'` で引ける。影テーブルは作らない |
| トリガー（`new.` / `old.`） | plpgsql 関数 + トリガー（`NEW.` / `OLD.`） | `WHEN (NEW.fts_indexed = 1)` もそのまま翻訳。FTS への INSERT は `ON CONFLICT ... DO UPDATE` にして冪等にした |
| `PRAGMA` / `VACUUM` / `wal_checkpoint` | 不要（MVCC / autovacuum） | **「サーバーを止めて VACUUM」という運用項目が消えます** |
| `VACUUM INTO`（バックアップ） | `pg_dump` / `pg_basebackup` | `db:maintenance` の④に相当 |

外部キーは依存順に並べて生成します（PostgreSQL は参照先が先に必要）。生成物には SQLite 固有の構文が
残っていないかを自己点検させており、混入していれば生成が失敗します。

---

## 🚀 3. 手順A: 最初から PostgreSQL で建てる

> [!WARNING]
> 手順 1〜3 は**今すぐ実行できます**。手順 4 以降（アプリの起動）は**ドライバの実装待ち**です。

1. PostgreSQL 16+ を用意し、専用ロールと DB を作る（アプリに superuser を使わせない）。
   ```sql
   CREATE ROLE spica LOGIN PASSWORD '…';
   CREATE DATABASE spica OWNER spica;
   \c spica
   CREATE EXTENSION IF NOT EXISTS pg_trgm;   -- 管理者権限が必要（1 回だけ）
   ```
2. `.env` に接続先を設定する（`DB_PATH` は使わない）。**この値は公開ツリーに置かないでください**（SN-SNS 側の `.env` のみ）。
   ```
   DATABASE_URL=postgres://spica:…@127.0.0.1:5432/spica
   ```
3. スキーマを適用する。繰り返し実行しても安全です（`--reset` で作り直し）。
   ```bash
   npm run db:pg:schema
   npm run db:pg:init -- --dsn "$DATABASE_URL"
   ```
4. ⬜ **アプリの起動（未実装）** — ドライバが入るまでは SQLite で起動します。
5. ⬜ **テストを PG で実行（未実装）** — 実装後は既存の `npm run test:*` を両方の DB で緑にするのを完了条件にします。
6. バックアップは `pg_dump` の cron に置き換える。保持期間削除・保存方針の適用（アプリ側の処理）はそのまま使える想定です。
7. `VACUUM` 相当の作業は不要（autovacuum）。

---

## 🔄 4. 手順B: SQLite から PostgreSQL へ移行する

> [!IMPORTANT]
> **エクスポート / インポートは使いません。** 現在のエクスポートはユーザー単位のアーカイブで、ノードの全データは移りません（付録参照）。

**手順 3 まで（移送と検証）は今日から実行できます。** 切り替え（手順 5）はドライバの実装後です。

```bash
# 1) 書き込みを止める（告知のうえでサービス停止）
# 2) 控えを取る
npm run db:maintenance -- --backup-only

# 3) 移送する（外部キーの依存順に、1,000 行ずつ。中断しても再実行できる）
npm run db:pg:migrate -- --from data_astrabit.sqlite --dsn "$DATABASE_URL" --truncate --verify
```

移送ツールの挙動:

- **冪等**: `INSERT ... ON CONFLICT DO NOTHING` なので、途中で止めても再実行すれば続きから埋まります（`--truncate` で作り直し）。
- **検証**: `--verify` でテーブルごとの行数と内容の要約（行ごとの md5 を XOR と加算でまとめた、順序に依存しない値）を突き合わせます。
- **スキーマのずれに強い**: 実データにだけ存在する列（過去に手で足された列など）はスキップして警告します。
  例: このノードの `channels` テーブルには `icon_url` と `users_count` がありましたが、コードからは使われていない旧列でした。
- `--dry-run` で件数確認だけ、`--tables` / `--skip` で対象を絞れます。

4. 検証結果を確認する（全テーブルで「行数と内容の要約が一致」と出れば成功）。
5. ⬜ **切り替え（未実装）** — ドライバ実装後に `.env` を `DATABASE_URL` に切り替えて起動する。
6. 切り戻し: SQLite のファイルは無傷なので、`.env` を戻して再起動すれば元に戻ります。移行中に PG 側で受けた書き込みは失われるため、切り替えは書き込みを止めた短時間で行います。
7. 後片付け: 問題がなければ SQLite ファイルは当面保管する（すぐには消さない）。

移行の対象外・別扱い:

| 対象 | 扱い |
| :--- | :--- |
| メディア実体（`data/uploads`） | DB ではなくファイル。S3 / R2 にある場合はそのまま |
| 画像プロキシのキャッシュ | 再生成されるので移送しない（テーブルは移送されますが実体は不要） |
| FTS 索引 | `posts_fts` として移送される（PG 側の索引は生成時に作られる） |
| セッション | 移送後に再ログインを促すのが安全 |

---

## ✅ 5. 検証（`npm run test:pg-port`）

PostgreSQL を用意して実行します（未設定なら終了コード 2 でスキップ）。

```bash
TEST_DATABASE_URL=postgres://spica:…@127.0.0.1:5432/spica_test npm run test:pg-port
```

検証内容（27 項目）:

1. スキーマ生成: 実際の migrations から PG DDL を作り、SQLite 固有の構文が残らないこと
2. スキーマ適用: `--reset` で作り直して適用できること
3. データ移送: 代表的なデータ（日本語・CW・添付・アンケート・絵文字・リスト・アンテナ・監査ログなど）を移送し、行数と内容が一致すること
4. FTS: `posts_fts` に索引が入り、日本語の部分一致で引けること（`enable_seqscan=off` で trigram 索引が使われることも確認）
5. トリガー: PG 側で投稿を INSERT / UPDATE / DELETE すると `posts_fts` が追随し、`fts_indexed = 0` は索引しないこと
6. 外部キー: 参照先が無い行が拒否され、`ON DELETE CASCADE` が効くこと

---

## 🚫 6. やらないこと

- **二重対応の恒久保守はしない。** SQLite と PG の両方で動くコードを維持し続けると、テストも運用も 2 倍になる。PG 対応を入れるなら「どちらかを選ぶ」形にし、テストだけ両方で回す。
- **案B（同期ファサード）を常用しない。** 移行の足場としてのみ許容する。
- **エクスポート / インポートをノード移行に使わない。** ユーザー単位のアーカイブなので全データは移らない（付録）。

---

## 📌 7. 現状の推奨（2026-09 時点）

| 規模の目安 | 推奨 |
| :--- | :--- |
| 数十人のアクティブ | **SQLite のままで問題ない。** 伸びてきたら保持期間・索引方針・メディア外部化（S3/R2）で調整する |
| 数百人の日次アクティブ / 書き込み競合が見え始めた | ドライバ（案A）を実装して PostgreSQL へ切り替える。スキーマと移送は準備済み |
| 数千人以上 | Mastodon / Misskey が適所（Spica の設計思想とは別の用途） |

---

## 📎 付録: エクスポート / インポートの範囲（移行の代替にならない理由）

- **エクスポート**（`server/src/exportService.ts`）は**ユーザー単位**のアーカイブ。含まれるのは `users` / `posts` / `announces` / `reactions` / `bookmarks` / `follows`。リスト・アンテナ・ミュート / ブロック・通知設定・メディア実体・サーバー設定（ルール、リレー、ロール、ブロック済みドメインなど）は含まれない。
- **インポート**（`server/src/importService.ts`）は Mastodon / Misskey のアーカイブから**投稿（と添付）**を取り込むもの。

これらは「ユーザーが別ノードへ引っ越す」ための道具で、「ノードごと DB を移す」ための道具ではありません。
