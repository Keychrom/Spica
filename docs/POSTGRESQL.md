# 🐘 PostgreSQL 対応（現状と手順）

> [!IMPORTANT]
> **アプリ本体も PostgreSQL で動きます（実験的）。** `DB_DRIVER=postgres DATABASE_URL=...` で起動すると、
> 同期 API のまま PostgreSQL に接続します（同期ファサード）。
> 恒久的にはデータ層の非同期化（下の「案A」）へ移す前提で、まず動く状態を作った段階です。
> **既定は SQLite のまま**で、切り替えない限り何も変わりません。
>
> | 項目 | 状態 | 使い方 |
> | :--- | :--- | :--- |
> | 移植コストの計測 | ✅ 実装済み | `npm run db:port-report` |
> | PostgreSQL スキーマの生成 | ✅ 実装済み | `npm run db:pg:schema` |
> | スキーマの適用 | ✅ 実装済み | `npm run db:pg:init -- --dsn "$DATABASE_URL"` |
> | SQLite → PostgreSQL のデータ移送 | ✅ 実装済み | `npm run db:pg:migrate -- --from ... --dsn ... --verify` |
> | **アプリ本体のドライバ（PG で起動する）** | ✅ 実装済み（同期ファサード） | `DB_DRIVER=postgres DATABASE_URL=... npm start` |
> | SQL 翻訳の単体検証 | ✅ 実装済み | `npm run test:pg-translate`（PG 不要） |
> | PG 上での検証（スキーマ・移送・検索・トリガー） | ✅ 実装済み | `TEST_DATABASE_URL=... npm run test:pg-port` |
> | 既存テストスイートの PG 対応 | 🚧 一部 | HTTP だけで完結するスイートはそのまま PG で通る（下記に個別の状態） |
> | データ層の非同期化（案A） | ⬜ 未着手 | 恒久対応。数週間規模 |

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

最大の論点は構文の置換ではなく**同期 API**です。Spica は `node:sqlite` の同期 API（573 箇所）を使っており、
PostgreSQL のクライアントは非同期なので、ここで道が 2 つに分かれます。

### 実装した道: 同期ファサード（案B）

`server/src/db/driver.ts` + `server/src/db/pgWorker.ts`。

- worker thread に `pg` の接続を 1 本持ち、メインスレッドは `SharedArrayBuffer` + `Atomics.wait` で結果を待つ。
  既存の 573 箇所は**一切変更していない**（`db.prepare(...).get/all/run` の形がそのまま動く）。
- 1 接続なのでトランザクション（BEGIN / COMMIT）もそのまま効く。SQLite と同じ「1 クエリごとにブロックする」
  性質で、構造的な劣化ではない（レイテンシはネットワーク分だけ増える）。
- 結果は JSON で運び、16MB を超えたら必要なサイズで再試行（上限 256MB）。Buffer / Date / BigInt は専用の表現に変換。
- 起動に失敗した worker を無限に作り直さないよう、3 回失敗したら明示的なエラーにする。
- worker に渡す node オプションは**ローダー指定だけ**に絞る（`--max-old-space-size` や `--inspect` を渡すと起動に失敗する）。

### 残っている道: データ層の非同期化（案A）

SQL をリポジトリ層へ集約し、呼び出しを `await` に変えていく。573 箇所に加えて呼び出し元
（ルートハンドラ、サービス、スケジューラ、CLI）まで連鎖し、**数週間規模**。テストを両方の DB で
回せる状態を保ちながら段階的に進めるのが安全です。

> [!TIP]
> いまは案Bで「PG でも動く」状態にあり、案A は恒久対応として残しています。両案で必要な
> スキーマ・移送・検証は先に済ませてあります。

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
| **手動メンテナンス CLI** | `npm run db:maintenance` は SQLite 専用 | PG では使わない。保持期間削除と方針適用はアプリ内の自動メンテナンスが担当する |
| **検索の順序** | SQLite の `bm25` 順位付けを `published_at` の新しい順で代用 | 語の出現頻度を考慮した順位にはならない（該当件数と内容は同じ） |
| **短い検索語** | trigram 索引は 3 文字未満だと効きにくい | 1〜2 文字の検索は全走査になる。機能は同じで遅いだけ |
| **worker の異常** | 起動に 3 回失敗したら明示的なエラーで停止する | 黙って SQLite に落ちたりはしない（誤動作より停止を選ぶ） |
| **セッション** | 移送後にテーブルは引き継がれる | とはいえ移行時は再ログインを促すのが安全 |

### テストスイートを PG で回す場合

各スイートは「まっさらな SQLite ファイル」を前提にしているので、PG では**実行の前に DB を作り直します。**

```bash
npm run db:pg:init -- --dsn "$TEST_DATABASE_URL" --reset
DB_DRIVER=postgres DATABASE_URL="$TEST_DATABASE_URL" npm run test:pagination
```

スイート側に手当てが要るものもあります。

| スイート | PG での状態 |
| :--- | :--- |
| `test-pagination` / `test-announcements` | ✅ そのまま通る |
| `test-password-auth` | 🚧 HTTP の検査（登録・ログイン・マスターキー・拒否）は全部通る。最後の「平文で保存されない」検査だけが **SQLite ファイルを直接開く**ため PG では開けずに失敗する |
| `test-federation` | ❌ 2 つのノードが別々の SQLite ファイルを消して回る作り。PG ではノードごとに DB を分ける改造が要る |

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

## 🚫 7. やらないこと

- **二重対応の恒久保守はしない。** SQLite と PG の両方で動くコードを維持し続けると、テストも運用も 2 倍になる。
  いまは SQLite が既定で、PG は「選んだときだけ使う道」。常用するならどちらかに寄せる。
- **同期ファサード（案B）を恒久の解にしない。** いまアプリはこの方式で PG に繋がっているが、これは
  573 箇所を書き換えずに移行できるようにするための足場。常用するなら案A（データ層の非同期化）へ移す。
- **エクスポート / インポートをノード移行に使わない。** ユーザー単位のアーカイブなので全データは移らない（付録）。

---

## 📌 8. 現状の推奨（2026-09 時点）

| 規模の目安 | 推奨 |
| :--- | :--- |
| 数十人のアクティブ | **SQLite のままで問題ない。** 伸びてきたら保持期間・索引方針・メディア外部化（S3/R2）で調整する |
| 数百人の日次アクティブ / 書き込み競合が見え始めた | PostgreSQL へ切り替える（スキーマ・移送・起動は準備済み）。それでも足りなければ案Aへ |
| 数千人以上 | Mastodon / Misskey が適所（Spica の設計思想とは別の用途） |

---

## 📎 付録: エクスポート / インポートの範囲（移行の代替にならない理由）

- **エクスポート**（`server/src/exportService.ts`）は**ユーザー単位**のアーカイブ。含まれるのは `users` / `posts` / `announces` / `reactions` / `bookmarks` / `follows`。リスト・アンテナ・ミュート / ブロック・通知設定・メディア実体・サーバー設定（ルール、リレー、ロール、ブロック済みドメインなど）は含まれない。
- **インポート**（`server/src/importService.ts`）は Mastodon / Misskey のアーカイブから**投稿（と添付）**を取り込むもの。

これらは「ユーザーが別ノードへ引っ越す」ための道具で、「ノードごと DB を移す」ための道具ではありません。
