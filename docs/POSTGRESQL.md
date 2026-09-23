# 🐘 PostgreSQL 対応（現状と手順）

> [!IMPORTANT]
> **アプリ本体も PostgreSQL で動きます。** `DB_DRIVER=postgres DATABASE_URL=...` で起動すると、
> 非同期データ層（下の「歩んだ道」）が PostgreSQL に接続します。
> **既定は SQLite のまま**で、切り替えない限り何も変わりません。
>
> | 項目 | 状態 | 使い方 |
> | :--- | :--- | :--- |
> | 移植コストの計測 | ✅ 実装済み | `npm run db:port-report` |
> | PostgreSQL スキーマの生成 | ✅ 実装済み | `npm run db:pg:schema` |
> | スキーマの適用 | ✅ 実装済み | `npm run db:pg:init -- --dsn "$DATABASE_URL"` |
> | SQLite → PostgreSQL のデータ移送 | ✅ 実装済み | `npm run db:pg:migrate -- --from ... --dsn ... --verify` |
> | **アプリ本体のドライバ（PG で起動する）** | ✅ 実装済み（非同期データ層） | `DB_DRIVER=postgres DATABASE_URL=... npm start` |
> | SQL 翻訳の単体検証 | ✅ 実装済み | `npm run test:pg-translate`（PG 不要） |
> | 非同期データ層（案A） | ✅ 完了（610 箇所） | `npm run test:db-async` / 状態は `npm run db:async:status` |
> | PG 上での検証（スキーマ・移送・検索・トリガー） | ✅ 実装済み | `TEST_DATABASE_URL=... npm run test:pg-port` |
> | 既存テストスイートの PG 対応 | ✅ 主要どころ | 16 スイートが PG でも全項目緑（下記に個別の状態） |
> | データ層の非同期化（案A） | ✅ 完了（同期ファサード・worker は削除済み） | 経緯は下の「歩んだ道」 |

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
| `IFNULL` | 2 | 置換（`COALESCE` へ。通報の重複判定で使っていた） |
| `LIKE` | 41 | 置換（`ILIKE` へ。SQLite の LIKE は ASCII で大文字小文字を区別しないため） |
| `BEGIN IMMEDIATE` | 1 | 置換（`BEGIN` へ。保持期間の削除で使っていた。PostgreSQL には IMMEDIATE が無い） |
| 2 引数の `MAX` / `MIN` | 1 | 置換（`GREATEST` / `LEAST` へ。SQLite のスカラー関数。チャンネルのフォロワー数で使っていた） |

> [!IMPORTANT]
> `db.exec(...)` も `prepare` と同じ翻訳を通します（`BEGIN IMMEDIATE` や `temp.` は exec 側で使われるため）。
> 文ごとに分割してから翻訳し、`PRAGMA` だけを落とします。

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

最大の論点は構文の置換ではなく**同期 API**です。Spica は `node:sqlite` の同期 API（573 箇所）を使っており、
PostgreSQL のクライアントは非同期なので、ここで道が 2 つに分かれます。

### 歩んだ道

1. **案B（足場・削除済み）**: `server/src/db/driver.ts` + `server/src/db/pgWorker.ts` に、worker thread と
   `SharedArrayBuffer` + `Atomics.wait` で PostgreSQL を**同期 API のまま**使うファサードを用意した。
   573 箇所を書き換えずに「PG でも動く」状態を作るための足場で、正しさの検証（スキーマ・移送・翻訳）を
   先に済ませるために使った。
2. **案A（本命・完了）**: データ層を非同期化し、案B のファサードと worker は**削除した**。

いまアプリが使うのは `server/src/db/asyncDriver.ts` の非同期インターフェースだけです。
SQLite は `node:sqlite` の同期接続を 1 本だけ開いて包み、PostgreSQL は `pg` クライアントに
直列化して投げます（worker も `Atomics.wait` も使わない）。

```ts
import { db } from './db.js';

const row = await db.prepare('SELECT ... WHERE id = ?').get(id);
await db.prepare('UPDATE ...').run(value, id);
await db.exec('PRAGMA journal_mode = WAL;');   // SQLite のときだけ意味がある（PG では無視される）
```

#### 案A の進め方（記録・2026-09 完了）

移行は「葉 → 中核 → ルート → db.ts」の順で、1 ファイルずつ進めました。

手順（1 ファイルずつ、下から上へ）:

1. `npm run db:async:status` で残りを確認し、**自分で SQL を持っている葉のモジュール**から選ぶ
   （`auditLog.ts` や `imageNotifier.ts` のような、他のモジュールの関数を経由しないもの）。
2. `import { db }` を `import { adb }` に変え、`db.prepare(...)` を `await adb.prepare(...)` にする。
3. それを含む関数を `async` にする。呼び出し元にも `await` を伝播させる
   （Express のハンドラは `async (req, res) => {}` にし、**try/catch を必ず付ける**。
   Express 4 は非同期の失敗を拾わないため、付け忘れるとプロセスが落ちる）。
4. `res.on('finish')` のような await できない場所は `void fn().catch(() => {})` にする。
5. `npx tsc -p server/tsconfig.json --noEmit` → 既存スイートを SQLite と PostgreSQL の両方で実行。
6. `npm run db:async:status` で数字が減ったことを確認。

トランザクション: 変換した範囲では `withTransaction(adb, async () => {...})` を使います。
PostgreSQL では 1 接続に直列化しているので `fn` の中に他のクエリが割り込みません。
**1 つのトランザクションを同期版と非同期版にまたがらせないこと**（接続が別なので、書き込み前の
データが非同期側から見えない）。トランザクションのある範囲はまとめて変換します（アプリ内は 2 箇所だけ）。

進捗の目安（数字は `npm run db:async:status` の出力）:

| 段階 | 内容 |
| :--- | :--- |
| ✅ 土台 | 非同期ドライバ、契約テスト（`npm run test:db-async`）、進捗の可視化 |
| ✅ 葉のモジュール | `auditLog` / `emailNotifier` / `imageProxy` / `maintenanceService` / `pushService` / `linkPreview` / `reportService` / `webauthnService` / `mediaService` / `accountService` / `deliveryQueue` |
| ✅ 中核 | `postService`（投稿作成）/ `auth`（セッション・権限）/ `activitypub`（配送とアクター取得）/ `scheduler`（予約投稿）/ `mailService` / `exportService` |
| ✅ 読み取りの要 | `routes/api.ts` のタイムライン整形（`enrichAndFilterPosts`）。リンクプレビューは行ごとではなく 1 回のクエリでまとめて取る |
| ✅ ルート | `routes/api.ts`（231 箇所）/ `admin.ts`（67）/ `inbox.ts`（50）/ `users.ts`（9）— ハンドラ単位の機械的な変換で移行 |
| ✅ 仕上げ | `db.ts`（32）/ `instanceActor` / `webfinger` / `shutdown`。**設定とインスタンス鍵は起動時にメモリへ読み込む方式**にした（`loadServerSettings` / `loadInstanceActorKeyPair`）ので、読み取りは同期のまま |
| ✅ 完了処理 | 同期ファサード（worker / `Atomics.wait` / `pgWorker.ts`）と同期 `db` を削除し、`adb` を `db` に改名（610 箇所） |
| ✅ メンテナンス系 | `dbMaintenance` の共通部分（削除計画・実行・孤立メディア・DB サイズ）も非同期化。SQLite 専用の操作（VACUUM / `VACUUM INTO` / ページ数）だけを生の接続に残した |

同期のまま残す場所（設定・鍵・表示判定のように、同期であることが設計上都合のよいもの）:

| 場所 | 理由 |
| :--- | :--- |
| `getServerSetting()` / `getInstanceActorKeyPair()` | 起動時にメモリへ読み込む（`loadServerSettings` / `loadInstanceActorKeyPair`）。`config` と同じ扱いでリクエスト処理中に同期で読める |
| `dbMaintenance` の SQLite 専用操作 | `VACUUM` / `VACUUM INTO` / `wal_checkpoint` / ページ数は PostgreSQL に無い。生の接続（`DatabaseSync`）のまま |
| `dbMaintenance` の `readSetting(conn, key)` | 接続を渡せばその接続から、渡さなければメモリのキャッシュから読む（どちらも非同期） |

> [!IMPORTANT]
> 非同期にした関数は、**呼び出し側にも `await` を伝播させる**こと。付け忘れると
> `Promise` がそのまま返り、API の応答が壊れる（例: 通報一覧が `reports: {}` になる）。
> `tsc` は `res.json(...)` の中身までは見ないので、**目視とスイートの両方**で確認する。
> Express のハンドラを async にしたら `asyncHandler()`（server/src/asyncHandler.ts）で包む。
> Express 4 は非同期の失敗を拾わず、包まないとプロセスが落ちる。

> [!NOTE]
> 接続は 1 本だけです（SQLite も PostgreSQL も）。トランザクションは `withTransaction(db, async () => {...})` で
> 囲み、その中は他リクエストのクエリが割り込みません。
> **同期接続と非同期接続を 1 つのトランザクションにまたがらせないこと**は変わりませんが、いま同期接続を持つのは
> SQLite 専用のメンテナンス CLI（`dbMaintenance`）だけです。

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

> [!NOTE]
> 手順 1〜5 はすべて実行できます（アプリは `DB_DRIVER=postgres` で起動します）。手順 5 のあとの
> テスト実行と、PG 側の運用（バックアップ）だけが未整備です。

1. PostgreSQL 16+ を用意し、専用ロールと DB を作る（アプリに superuser を使わせない）。
   ```sql
   CREATE ROLE spica LOGIN PASSWORD '…';
   CREATE DATABASE spica OWNER spica;
   \c spica
   CREATE EXTENSION IF NOT EXISTS pg_trgm;   -- 管理者権限が必要（1 回だけ）
   ```
2. `.env` に接続先を設定する（`DB_PATH` は使わない）。**この値は公開ツリーに置かないでください**（SN-SNS 側の `.env` のみ）。
   ```
   DB_DRIVER=postgres
   DATABASE_URL=postgres://spica:…@127.0.0.1:5432/spica
   ```
   `DB_DRIVER` を書かなければ従来どおり SQLite です（既定は変わりません）。
3. スキーマを適用する。繰り返し実行しても安全です（`--reset` で作り直し）。
   ```bash
   npm run db:pg:schema
   npm run db:pg:init -- --dsn "$DATABASE_URL"
   ```
   > [!TIP]
   > `db:pg:init` は省略できます。アプリは起動時に `schema.pg.sql` を適用し、足りないテーブルを自分で作ります。
   > 明示的に流しておくほうが、失敗したときに原因が分かりやすくなります。
4. **アプリの起動** — ビルドして起動するだけです。起動ログに `🐘 PostgreSQL スキーマを適用しました` が出れば接続できています。
   ```bash
   npm run build
   DB_DRIVER=postgres DATABASE_URL="$DATABASE_URL" npm start
   ```
5. 動作確認は `curl http://127.0.0.1:3000/api/health`、タイムライン、検索、投稿の作成あたりから。
   FTS は `ILIKE` に置き換わるので、日本語の部分一致も含めて検索が動くことを確認してください。
6. バックアップは `pg_dump` の cron に置き換える。保持期間削除・保存方針の適用（アプリ内の自動メンテナンス）は
   PG でもそのまま動きます。**`npm run db:maintenance`（手動 CLI）は SQLite 専用**なので、PG では使いません。
7. `VACUUM` 相当の作業は不要（autovacuum）。

---

## 🔄 4. 手順B: SQLite から PostgreSQL へ移行する

> [!IMPORTANT]
> **エクスポート / インポートは使いません。** 現在のエクスポートはユーザー単位のアーカイブで、ノードの全データは移りません（付録参照）。

**移送から切り替えまで実行できます。** ただし切り替えは書き込みを止めた短時間で行ってください。

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
5. **切り替え** — `.env` に次の 2 行を入れて起動し直す。SQLite ファイルはそのまま残るので、切り戻しはこの 2 行を消すだけです。
   ```
   DB_DRIVER=postgres
   DATABASE_URL=postgres://spica:…@127.0.0.1:5432/spica
   ```
   切り替え後に投稿・検索・通知・画像プロキシが動くことを確認してください。移行中に PG 側で受けた書き込みは
   切り戻しで失われるため、切り替えは書き込みを止めた短時間で行います。
6. 切り戻し: `.env` を戻して再起動すれば元に戻ります。
7. 後片付け: 問題がなければ SQLite ファイルは当面保管する（すぐには消さない）。

移行の対象外・別扱い:

| 対象 | 扱い |
| :--- | :--- |
| メディア実体（`data/uploads`） | DB ではなくファイル。S3 / R2 にある場合はそのまま |
| 画像プロキシのキャッシュ | 再生成されるので移送しない（テーブルは移送されますが実体は不要） |
| FTS 索引 | `posts_fts` として移送される（PG 側の索引は生成時に作られる） |
| セッション | 移送後に再ログインを促すのが安全 |

---

## 🐘 5. 動かすときの前提と制約（第二段階）

### 仕組み

`db.prepare(sql).get() / .all() / .run()` の形は SQLite とまったく同じです。違いは中身で、PG のときは
別スレッドの worker に投げて `Atomics.wait` で待ちます。**呼び出し側のコードは 1 行も変わっていません。**

| 項目 | SQLite | PostgreSQL |
| :--- | :--- | :--- |
| 接続 | プロセス内のファイル | worker スレッド内の `pg` クライアント 1 本 |
| 待ち方 | 同期（そのまま） | 同期（`SharedArrayBuffer` + `Atomics.wait`） |
| トランザクション | `BEGIN` / `COMMIT` | 同じ（1 接続なのでそのまま効く） |
| 並列度 | なし（1 クエリずつ） | なし（1 接続に直列化。プールは使っていない） |
| 結果の受け渡し | 参照 | JSON に変換してコピー（16MB 超は必要サイズで再試行、上限 256MB） |

### 検証済みの範囲（2026-09-22）

- **HTTP で完結するテストスイート**: `test-pagination` と `test-announcements` が全項目パス。
- **手動の一巡**: 登録 → ログイン → 投稿 → タイムライン → 検索（日本語の部分一致）→ 通知 → 管理画面。
- **ビルド成果物でも起動**: `npm run build` 後の `dist` で PG 起動を確認（worker は `.js` を選ぶ）。
- **実データ**: ライブノードの 187,072 行を移送した DB で起動し、タイムラインと検索が返ること。
- **SQL 翻訳**: `npm run test:pg-translate`（17 項目、PG 不要）。

### 制約（把握したうえで使う）

| 制約 | 内容 | 影響 |
| :--- | :--- | :--- |
| **書き込みが直列** | worker も接続も 1 本。同時リクエストはクエリ単位で並ぶ | 読み取り中心のノードでは SQLite より遅くなりうる（1 クエリごとにスレッド間往復が入る） |
| **大きな結果** | 結果は JSON でコピーする | 巨大な `BLOB` を大量に読む処理は苦手。投稿やユーザーの一覧は問題なし |
| **バックアップ** | `VACUUM INTO` は SQLite 専用 | PG では `pg_dump` を使う。アプリ内の自動バックアップは PG では動かない（スキップする） |
| **手動メンテナンス CLI** | `npm run db:maintenance` は SQLite 専用 | PG では使わない。保持期間削除と方針適用はアプリ内の自動メンテナンスが担当する（下記） |
| **自動メンテナンス** | 保持期間の削除・方針適用はどちらの DB でも動く | PG では削除のときに FTS 同期トリガを外さない（SQLite のトリガ定義を流すと構文エラーになるため修正済み） |
| **検索の順序** | SQLite の `bm25` 順位付けを `published_at` の新しい順で代用 | 語の出現頻度を考慮した順位にはならない（該当件数と内容は同じ） |
| **短い検索語** | trigram 索引は 3 文字未満だと効きにくい | 1〜2 文字の検索は全走査になる。機能は同じで遅いだけ |
| **バイナリ列** | SQLite は `Uint8Array`、PG は `Buffer` で返る | 現在のスキーマにバイナリ列は無い（鍵や画像は TEXT の base64）。増やすときは注意 |
| **worker の異常** | 起動に 3 回失敗したら明示的なエラーで停止する | 黙って SQLite に落ちたりはしない（誤動作より停止を選ぶ） |
| **セッション** | 移送後にテーブルは引き継がれる | とはいえ移行時は再ログインを促すのが安全 |

### テストスイートを PG で回す場合

各スイートは「まっさらな DB」を前提にしているので、PG では**実行の前に DB を作り直します。**
まとめて回すためのスクリプトを用意してあります（各スイートの前で `db:pg:init --reset` を実行）。

```bash
bash scripts/run-suites-pg.sh                 # PG で回せるスイートを順に実行
bash scripts/run-suites-pg.sh admin-audit     # 個別に実行

# 手で 1 本だけ回す場合
npm run db:pg:init -- --dsn "$TEST_DATABASE_URL" --reset
DB_DRIVER=postgres DATABASE_URL="$TEST_DATABASE_URL" npm run test:pagination
```

**いま PG でも緑になるスイート（16 本）**: `pg-port`（27 項目）/ `pg-translate`（28）/
`db-async`（41）/ `admin-audit` / `email-notify` / `image-proxy` / `ops-automation` / `reports` /
`silence-featured` / `pagination` / `announcements` / `antennas-and-scheduler` / `account-deletion` /
`fts-push` / `export-and-rules` / `theme-channels-webauthn` / `db-maintenance`

SQLite 側の全スイート（36 本）は `bash scripts/run-suites.sh` でまとめて回せます。

| スイート | PG での状態 |
| :--- | :--- |
| 上記 16 本 | ✅ 全項目通る（seed をアプリと同じドライバで行うように直した） |
| `test-password-auth` | 🚧 HTTP の検査（登録・ログイン・マスターキー・拒否）は全部通る。最後の「平文で保存されない」検査だけが **SQLite ファイルを直接開く**ため PG では開けずに失敗する |
| `test-search-policy` | 🚧 直近の `posts_fts` を直接いじる検査があり、SQLite 前提（PG では trigram 索引側の検査として `test-pg-port` が担当） |
| `test-db-maintenance` | ❌ VACUUM / `VACUUM INTO` / `sqlite_master` の検査を含む SQLite 専用のスイート。PG 側の保全は `db:maintenance` ではなく `pg_dump` + 手動 SQL |
| `test-federation` | ❌ 2 つのノードが別々の SQLite ファイルを消して回る作り。PG ではノードごとに DB を分ける改造が要る |

> [!NOTE]
> スイートが `new DatabaseSync(...)` で直接 SQLite を開いて seed していると、PG では空のファイルを
> 開いて `no such table` で落ちます。`createAsyncDatabase({ driver: process.env.DB_DRIVER, connectionString:
> process.env.DATABASE_URL, dbPath: ... })` に置き換えると、どちらの DB でも同じ検査が流せます
> （`test-admin-audit.ts` / `test-email-notify.ts` が実例）。
> 逆に「SQLite ファイルを直接開いて中身を確かめる」検査（`test-password-auth` など）は PG では
> そのままでは動かないので、`createAsyncDatabase` 経由の確認に置き換えていきます。

---

## ✅ 6. 検証（`npm run test:pg-port`）

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

## 🔧 7. 残っている手作業（メモ）

データ層の非同期化（案A）は完了しました。いま同期のまま残っているのは次の 2 つだけです。

- `getServerSetting()` / `getInstanceActorKeyPair()` — 起動時にメモリへ読み込む。`config` と同じ扱い。
- `dbMaintenance` の SQLite 専用操作（`VACUUM` / `VACUUM INTO` / `wal_checkpoint` / ページ数） —
  PostgreSQL に無い操作なので、生の接続（`DatabaseSync`）のまま。共通部分は非同期化済み。

運用・方針として残るもの:

- **二重対応の恒久保守はしない。** SQLite と PG の両方で動くコードを維持し続けると、テストも運用も 2 倍になる。
  いまは SQLite が既定で、PG は「選んだときだけ使う道」。常用するならどちらかに寄せる。
- **エクスポート / インポートをノード移行に使わない。** ユーザー単位のアーカイブなので全データは移らない（付録）。
- **PG の保全は `pg_dump`。** SQLite 用の `npm run db:maintenance`（VACUUM / バックアップ）は SQLite 専用。
  自動メンテナンス（保持期間の削除・索引方針の適用）はどちらの DB でも動く。

---

## 📌 8. 現状の推奨（2026-09 時点）

| 規模の目安 | 推奨 |
| :--- | :--- |
| 数十人のアクティブ | **SQLite のままで問題ない。** 伸びてきたら保持期間・索引方針・メディア外部化（S3/R2）で調整する |
| 数百人の日次アクティブ / 書き込み競合が見え始めた | PostgreSQL へ切り替える（スキーマ・移送・起動は準備済み。データ層は非同期化済み） |
| 数千人以上 | Mastodon / Misskey が適所（Spica の設計思想とは別の用途） |

---

## 📎 付録: エクスポート / インポートの範囲（移行の代替にならない理由）

- **エクスポート**（`server/src/exportService.ts`）は**ユーザー単位**のアーカイブ。含まれるのは `users` / `posts` / `announces` / `reactions` / `bookmarks` / `follows`。リスト・アンテナ・ミュート / ブロック・通知設定・メディア実体・サーバー設定（ルール、リレー、ロール、ブロック済みドメインなど）は含まれない。
- **インポート**（`server/src/importService.ts`）は Mastodon / Misskey のアーカイブから**投稿（と添付）**を取り込むもの。

これらは「ユーザーが別ノードへ引っ越す」ための道具で、「ノードごと DB を移す」ための道具ではありません。
