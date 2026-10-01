# 🏗 Spica の設計 — プロセスと、状態の置き場所

> この文書は「Spica がどう動いていて、**どこを増やせば何人まで持つか**」を、
> プロセスの構成と状態の置き場所から説明するものです。
> **速さの実測値・負荷試験の結果は [SCALE.md](SCALE.md) にあります**（ここには数字を重複して書きません）。
> 2026-09 に `PROCESS_ROLE`（役割の分離）を実装し、そのときに見つかった
> 「複数プロセスで回すと静かに壊れる」2 件も直しました（[🧷 二重実行を防ぐ](#-二重実行を防ぐ)）。

---

## 🧩 1 プロセスがやること（`PROCESS_ROLE`）

既定（未設定 = `all`）は今までどおり、**1 プロセスが HTTP も定期処理も担当**します。
`PROCESS_ROLE` を設定すると役割を分けられます。

| 役割 | HTTP | 予約投稿 | 配送再送 | 背景ジョブ | 使いどころ |
| :--- | :---: | :---: | :---: | :---: | :--- |
| `all`（既定） | ✅ | ✅ | ✅ | ✅ | 1 台で完結させる。**設定を変えなくても今までどおり** |
| `web` | ✅ | — | — | — | 読み取りを横に増やす（同じ DB と Redis を共有して N 個並べる） |
| `worker` | — | ✅ | ✅ | ✅ | 重い定期処理を Web から追い出す。**ポートを掴まない** |

```bash
# 1 台で役割を分ける例（同じ .env を使い、PROCESS_ROLE だけ変える）
PROCESS_ROLE=web    PORT=3000 node dist/index.js   # 画面と API
PROCESS_ROLE=worker            node dist/index.js   # 定期処理だけ（HTTP を開かない）
```

- `http` は `web`、`jobs` は `worker` として扱います（表記ゆれの吸収）。知らない値は `all` に倒します。
- 役割は `/health` の `role` と `/metrics` の `spica_process_role_info{role="..."}` で見えます
  （増やしたプロセスがどれか、監視から見分けられます）。
- `worker` は HTTP を開かないので、**監視は systemd の `Restart=always` とログ**で見ます
  （DB が固まっても `DATABASE_STATEMENT_TIMEOUT_MS` でクエリが切れるので、ハングしたまま残りません）。

### 定期処理の間隔

| 処理 | 既定 | 環境変数 |
| :--- | ---: | :--- |
| 予約投稿の公開（+ 1 日 1 回の自動メンテナンス） | 10 秒 | `SCHEDULER_INTERVAL_MS` |
| 配送の再送（指数バックオフ） | 60 秒 | `DELIVERY_INTERVAL_MS` |
| 背景ジョブ（リンクプレビュー等。+ 10 分ごとに古いエクスポートを掃除） | 15 秒 | `JOB_INTERVAL_MS` |

> [!IMPORTANT]
> **`PROCESS_ROLE` を `all` 以外にするなら、Redis と PostgreSQL の併用を推奨します。**
> **予約投稿の二重公開は Redis 無しでも起きません**（ロックは DB の `app_locks` にフォールバックし、
> プロセスをまたいで 1 つだけが実行します）。Redis を入れる理由は**プロセス間で共有されない 3 つ**です:
> レート制限（プロセスごとに数えてしまう）・リアルタイム更新（SSE）・設定の変更の反映。
> 起動時にこの旨を警告として出します（止めはしません）。
> SQLite のままだと書き込みが 1 本に直列化されるので、プロセスを増やしても書き込みは速くなりません。

---

## 🗄 状態はどこにあるか

**「増やせるかどうか」は、状態がプロセスの外にあるかで決まります。**

| 状態 | 置き場所 | 複数プロセスでの扱い |
| :--- | :--- | :--- |
| セッション・ユーザー・投稿・鍵 | **DB** | ✅ どのプロセスでも認証・読み書きできる |
| レート制限のカウンタ | Redis（未設定ならプロセス内） | ✅ Redis があれば全プロセスで共有。無ければ**別々に数える**（＝制限がプロセス数倍ゆるくなる） |
| リアルタイム更新（SSE） | プロセスのメモリ + Redis Pub/Sub | ✅ 接続は 1 プロセスに属し、イベントは Pub/Sub で全プロセスへ配る |
| 設定（`server_settings`） | 各プロセスのメモリ + Redis 通知 | ✅ 変更時に通知が流れ、各プロセスが読み直す |
| インスタンス Actor の鍵 | **DB**（起動時に 1 度読む） | ✅ 同時起動の競合は 2026-09 に修正（[🧷 起動時の競合](#-起動時の競合インスタンス鍵)） |
| タイムラインの読み取りキャッシュ | Redis（未設定ならプロセス内） | ✅ Redis があれば共有。`TIMELINE_CACHE_TTL_SEC` は**既定 15 秒**（`0` で無効）。投稿・削除・ブースト・フォロー・ブロック・ミュートワード・ドメイン遮断、および連合からの受信の直後に世代番号を進めて捨てる |
| アップロード / サムネイル | **ローカルディスク** | ⚠️ **同じホストなら共有できるが、別ホストでは共有できない** → R2 / S3（`MEDIA_PUBLIC_BASE_URL`）が前提 |
| エクスポート・バックアップ | ローカルディスク（worker が作る） | ⚠️ 同上。worker を分けるなら置き場を共有する |
| 一時テーブル | 接続（`withSession()`） | ✅ セッション内で完結する（使い方は [POSTGRESQL.md](POSTGRESQL.md)） |

**つまり**: DB と Redis に寄せてある状態は横に増やせます。**ローカルディスクだけが「同じホスト」を要求します。**

---

## 🧷 二重実行を防ぐ

複数プロセス・複数ワーカーで回すときの要です。**「一覧してから掴む」形の競合**を避けています。

### 掴む条件は、一覧の条件と同じにする

配送（`outbox_deliveries`）と背景ジョブ（`jobs`）は、**条件付き UPDATE** で「自分がやる」と宣言してから実行します
（`FOR UPDATE SKIP LOCKED` は使いません — PostgreSQL 専用になり、SQLite で同じコードが動かなくなるためです）。

```sql
-- 一覧（listDueJobs / listDueDeliveries）
WHERE status = 'pending' AND next_attempt_at <= now
-- 掴む（claimJob / claimDelivery）— ★ 期限まで条件に入れる
SET status = 'running' WHERE id = ? AND status = 'pending' AND next_attempt_at <= now
```

`next_attempt_at <= now` を条件に入れるのは、**一覧してから掴むまでの間に、別のワーカーが
失敗させて次の試行を先へ延ばすことがある**ためです。これが無いと、30 秒待つはずのバックオフを飛ばして
**同じ仕事を即座に再実行**してしまいます（2026-09 に 2 ワーカーの同時運転で実際に起きました:
`attempts` が 1 のはずの行が 30 ミリ秒後に 2 になりました）。
`scripts/test-job-queue.ts` がこの不変条件を検査しています。

### 順序が要る仕事は「束」ごとに FIFO で掴む

受信の非同期処理（`INBOX_ASYNC`）のように**同じ相手の前後関係を壊せない**仕事は、
`jobs.group_key`（受信ではアクター URL）で束ね、**束の中の先行が残っている間は掴めない**条件で
宣言します（`claimJobInOrder`）。

```sql
-- 掴む（claimJobInOrder）— ★ 同じ束の「先行」が pending / running のうちは掴めない
WHERE id = ? AND status = 'pending' AND next_attempt_at <= now
  AND NOT EXISTS (SELECT 1 FROM jobs j
                   WHERE j.kind = ? AND j.group_key = ?
                     AND j.status IN ('pending','running')
                     AND (j.created_at < ? OR (j.created_at = ? AND j.id < ?)))
```

**一覧の並びも同じ順にそろえる必要があります**（`listDueJobs` は `created_at, id` の昇順）。
別の順（`next_attempt_at` など）で取り出すと、束の 2 件目以降が「先行がまだ残っている」と
見えて掴めず、**束ごとに 1 件ずつしか進みません**（実測で 11 件/s まで落ちました）。
順序を守る仕組みは、順序どおりに取るところまで 1 組です。

削除の順序（Delete の後に遅れて届いた Create）は、束の中の入れ替わりとは別に
**墓標**（`deleted_remote_posts`）でも止めます。Delete を処理したら ID を記録し、
後から届いた Create はその ID を捨てます。

### 予約投稿はロックで 1 プロセスだけ

予約投稿の公開は条件付き UPDATE ではなく、**`runExclusively('scheduler', 60 秒)` のロック**で
1 プロセスだけが実行します（実行が長引く間は TTL を延長します）。ロックの置き場所は 2 段構えです:

- **Redis があれば** Redis のロック（`SET NX PX` + **持ち主を確認した**延長 + 所有トークンで解放）。
  延長も解放も「自分のトークンのときだけ」効くので、TTL 切れで他プロセスが取り直した後に
  前のプロセスが延ばしてしまうことはありません
- **Redis が無い（または取得に失敗した）ときは DB のロック**（`app_locks` テーブル。TTL つき）。
  **プロセスをまたいで排他される**ので、Redis 無しでも二重公開はしません
  （TTL 方式なので、プロセスが TTL 以上止まると他が奪い得る点だけ Redis より弱い）

行の側でも守っています: 公開の直前に `status = 'publishing'` へ条件付き UPDATE で「自分が公開する」と
宣言し、公開中に落ちた行は定期処理が 10 分後に待機中へ戻して拾い直します。

### 起動時の競合（インスタンス鍵）

インスタンス Actor の RSA 鍵は**初回起動時に生成して DB に保存**します。2 つのプロセスが同時に
起動すると「両方が鍵を作る」競合が起きます（片方の鍵は保存されず、**プロセスごとに違う鍵**を持つ状態になり、
そのプロセスが署名した Activity が相手側で検証に失敗します）。

保存できたかどうかを**結果で判定**して、入っていなければ保存済みの鍵を読み直します。

- SQLite: 重複した `INSERT` は**例外**になる。
- PostgreSQL: 素の `INSERT` は `ON CONFLICT DO NOTHING` に翻訳されるので、**例外にならず `changes = 0`** になる
  （[⚠️ ドライバで違うところ](#-ドライバで違うところ)）。

`scripts/test-process-roles.ts` が「同じ DB に 2 プロセスを同時に起動して、同じ公開鍵を配るか」を検査します。

---

## 🚀 配置のしかた

**1 台・1 プロセスから始めて、必要になったら分けられます。** 分けても設定は `PROCESS_ROLE` と
環境変数だけです（コードは同じ）。

### 1 台・1 プロセス（既定）

```ini
# /etc/systemd/system/spica.service
[Unit]
Description=Spica (ActivityPub node)
After=network.target

[Service]
Type=simple
User=spica
WorkingDirectory=/opt/spica/server
ExecStart=/usr/bin/node dist/index.js
Restart=always
RestartSec=5
EnvironmentFile=/opt/spica/.env
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

### 1 台・役割を分ける（Web は増やせる）

```ini
# spica-web.service（2 枚目は PORT=3001 で同じユニットをもう 1 つ）
[Service]
EnvironmentFile=/opt/spica/.env
Environment=PROCESS_ROLE=web
Environment=PORT=3000
ExecStart=/usr/bin/node dist/index.js

# spica-worker.service
[Service]
EnvironmentFile=/opt/spica/.env
Environment=PROCESS_ROLE=worker
ExecStart=/usr/bin/node dist/index.js
```

`nginx`（または Cloudflare）で `spica-web` へ振り分けます。**SSE（`/api/streaming`）はバッファリングを切ってください**
（設定例は [SETUP_Normal.md](SETUP_Normal.md)）。

```nginx
upstream spica { server 127.0.0.1:3000; server 127.0.0.1:3001; }

location /api/streaming {
  proxy_pass http://spica;
  proxy_buffering off;          # ← SSE は必ず切る
  proxy_read_timeout 1h;
}
location / { proxy_pass http://spica; }
```

### 別ホストに増やすときの前提

| 前提 | 理由 |
| :--- | :--- |
| PostgreSQL（`DB_DRIVER=postgres`） | SQLite のファイルは複数ホストで共有できない |
| Redis（`REDIS_URL`） | レート制限・SSE・設定・予約投稿のロックがプロセスをまたぐ |
| メディアを R2 / S3 に | ローカルディスクは共有できない |
| `DATABASE_POOL_MAX` × プロセス数 ≤ PostgreSQL の `max_connections` | 既定は 5。プロセスを増やすなら PgBouncer を前段に |
| 定期処理は 1 プロセスだけ | `PROCESS_ROLE=worker` は 1 つで足ります（増やすとロックの取り合いになるだけ） |

---

## 📐 何人まで持つか（この設計での見積もり）

**読み取りは横に増やせます。最後の壁は DB の書き込みと接続数です。**

| 構成 | 読み取り | 現実的な範囲 |
| :--- | :--- | :--- |
| SQLite + 1 プロセス（既定） | 実測 517〜670 req/s | **数十人が同時に使う規模**。連合の受信量が増えると書き込みが先に詰まる |
| PostgreSQL + Redis + web/worker 分離 | 実測 647〜1,207 req/s（2 プロセス） | **同時に数百人**。読みは `web` を増やして伸ばせる（DB が耐える限り） |
| 上記 + 読み取りレプリカ・CDN・パーティション | 未実測 | 数千人。**まだ実装していません**（[SCALE.md の設計変更](SCALE.md)） |

前提と注意:

- 数字は [SCALE.md](SCALE.md) の負荷試験（同時 20 接続・45 秒・作者の PC）です。**絶対値ではなく比較として読んでください。**
- 「1 人あたり毎秒 1 回未満のリクエスト」なら、`数百人` は上の読み取り性能の射程に入ります。
  **長時間の連続稼働と、もっと多くの利用者を混ぜた検証はまだです**（SCALE.md の「いまのいちばんの課題」）。
- **連合の受信は読み取りとは別の重み**です。リレーを購読すると 1 日 5 万件規模が流れ込み、
  DB は読み取りより先に「増え方」で問題になります（実測: 6 リレーで 24 時間に 57,339 件）。
  ここはコードではなく**運用（購読するリレーと保持期間）**で調整します。

---

## ⚠️ ドライバで違うところ

SQLite と PostgreSQL は同じコードで動きますが、**SQL の意味が 1 か所だけ違います**。

| 挙動 | SQLite | PostgreSQL（翻訳後） |
| :--- | :--- | :--- |
| 素の `INSERT` が重複したとき | **例外**（UNIQUE 制約） | `ON CONFLICT DO NOTHING` になり、**例外にならず `changes = 0`** |
| `INSERT OR REPLACE` / `INSERT OR IGNORE` | そのまま | `ON CONFLICT ... DO UPDATE` / `DO NOTHING` に翻訳 |
| 書き込みの並行性 | 1 本に直列化（WAL） | 並行（プール） |
| `datetime()` / `bm25()` / `posts_fts MATCH` | SQLite の関数 | 同等の式に翻訳（[POSTGRESQL.md](POSTGRESQL.md)） |

**「重複したら黙って入らない」ことを前提にした処理は、結果（`changes`）を見て判断してください。**
インスタンス鍵がその例です（[🧷 起動時の競合](#-起動時の競合インスタンス鍵)）。
逆に、**重複を検出して利用者に知らせたい処理**（同じユーザー名での登録など）は、
事前の `SELECT` だけに頼らず、`INSERT` の結果も見るのが安全です。

---

## 🧪 何を検査で守っているか

| 検査 | 守っていること |
| :--- | :--- |
| `scripts/test-process-roles.ts` | `web` は定期処理を動かさない / `worker` はポートを開かない / 既定（`all`）は今までどおり / **2 ワーカーで同じ仕事を二重に実行しない** / 同時起動でもインスタンス鍵が 1 つ / **助言ロックは同じ接続で取って解放する**（PostgreSQL） |
| `scripts/test-hardening.ts` | **タイムラインの読み取りキャッシュ**（1 回目は MISS・2 回目は HIT・投稿したら捨てる・`0` で無効・利用者ごとに別）/ **SQLite のトランザクションが他のリクエストを巻き込まない** / Redis 無しでもロックが効く / 予約投稿は 1 回だけ公開される / 外向き fetch は 1 ホップずつ検証して必ず打ち切る / SSE は上限で断る / **同じサーバーのフォロワーは 1 本に集約され、同時実行数は設定値以下**（アンケート更新も同じ形）/ 受信の受け入れ制御（**待ち時間 0 は待たずに 503**） |
| `scripts/test-inbox-signature.ts` | 署名の強制（なりすまし・改ざん・古い Date・未知の actor を拒否）/ **壊れた入力でもプロセスが落ちない** |
| `scripts/check-route-errors.ts`（`npm run check:routes`） | **ルートハンドラの未処理の Promise 拒否**（`try` の外の await を `asyncHandler` で包んでいるか。構文木で見る） |
| `scripts/test-multiprocess.ts` | 2 プロセスでレート制限・SSE・設定が共有される / 予約投稿が二重に公開されない / 配送が二重に送られない |
| `scripts/test-job-queue.ts` | 一覧→宣言の競合（バックオフ中の仕事を掴まない）/ 並列実行でも 1 件ずつ |
| `scripts/test-redis.ts` / `test-stream-scope.ts` | ロック・Pub/Sub・配信先の絞り込み |
| `scripts/test-backup-restore.ts` | SQLite / PostgreSQL のバックアップから復元して起動できる |

```bash
bash scripts/run-suites.sh              # SQLite で全スイート（引数で名前を絞れる: run-suites.sh redis）
bash scripts/run-suites-pg.sh           # PostgreSQL で（process-roles / hardening は同時運転まで回る）
npx tsx scripts/test-process-roles.ts   # 役割の検査だけ
npx tsx scripts/test-hardening.ts       # 堅牢性の検査だけ
npx tsx scripts/test-redis.ts           # 個別に走らせる場合（一部のスイートには npm script もあります）
```

> [!NOTE]
> スイートは**すべて `bash scripts/run-suites.sh <名前>` で走ります**（ポート・環境変数・後片付けは
> スクリプトが面倒を見ます）。個別に `npx tsx scripts/test-<名前>.ts` で叩くこともできますが、
> その場合は自分でポートと `DB_PATH` を決めてください。`npm run test:<名前>` が用意されているのは
> 一部のスイートだけです（`package.json` の `scripts` を参照）。

---

## 📌 この文書の位置づけ

- **速さの話は [SCALE.md](SCALE.md)**、PostgreSQL の移植と制約は [POSTGRESQL.md](POSTGRESQL.md)、
  Redis の役割は [REDIS.md](REDIS.md)、設定は [CONFIGURATION.md](CONFIGURATION.md) にあります。
- ここに書いた構成は**すべて任意**です。`PROCESS_ROLE` も `REDIS_URL` も `DB_DRIVER` も設定しなければ、
  今までどおり「1 プロセス・追加ミドルウェアなし」で動きます。
- 実装が変われば更新します（最終更新: 2026-10-01。受信ルートの例外処理（`asyncHandler` と `check:routes`）、助言ロックの接続固定、Redis ロックの延長の持ち主確認、`INBOX_QUEUE_WAIT_MS=0` の扱い、アンケート更新の連合の集約、**タイムラインの読み取りキャッシュ（既定 15 秒 + 書き込みでの無効化）**、**受信の非同期処理（`INBOX_ASYNC`）と束ごとの FIFO claim・墓標**、PostgreSQL の**列の差分適用**を反映）。
