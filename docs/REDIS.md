# 🔌 Redis を使う（複数プロセスで動かす）

> **既定では使いません。** `REDIS_URL` を設定したときだけ有効になり、未設定なら今までどおり
> インメモリの実装で動きます（1 プロセス前提）。Redis を入れると、**同じノードを複数のプロセスで
> 動かせる**ようになります（ロードバランサや PM2 の cluster モードで振り分けられる）。

このドキュメントは「なぜ要るのか」「どう設定するのか」「何が起きるのか」を順に書いたものです。

---

## 🤔 何が変わるのか

Spica は「1 プロセスで完結させる」設計なので、プロセスを増やすと次の 4 つが壊れます。
Redis はそこだけを埋めます。

| 機能 | Redis なし（既定） | Redis あり |
| :--- | :--- | :--- |
| **レート制限** | プロセスごとに数える（2 プロセスなら実質 2 倍まで通ってしまう） | カウンタを共有する（`/api/auth` は 20 回/分のままで効く） |
| **リアルタイム更新（SSE）** | 自分のプロセスに接続した人にしか届かない | Pub/Sub で全プロセスに届く（どのプロセスに繋いでいても同じ）。新着投稿は宛先を判定してから配り、判定材料もメッセージに含めるので、どのプロセスでも同じ相手に届く |
| **設定の変更** | 起動時に読んだきり（他のプロセスには反映されない） | 変更を通知して全プロセスが読み直す |
| **予約投稿・配送再送・自動メンテナンス** | 全プロセスが実行する（**同じ予約投稿を二重に公開しうる**） | 1 プロセスだけが実行する（ロックを取る） |
| **Redis が落ちたとき** | — | その場でインメモリにフォールバック（**ノードは止まらない**） |

> [!IMPORTANT]
> Redis は**レート制限やリアルタイム更新のため**のもので、**DB やアプリの処理能力は上がりません**。
> 数千人規模を目指すなら、Redis に加えて PostgreSQL（と、必要なら複数プロセス）が要ります。
> 順番と効果は [SCALE.md](SCALE.md) にまとめています。

---

## 🚀 手順

### 1. Redis を用意する

Debian / Ubuntu:

```bash
sudo apt install redis-server
sudo systemctl enable --now redis-server
redis-cli ping        # PONG が返れば OK
```

Docker:

```bash
docker run -d --name spica-redis --restart unless-stopped \
  -p 127.0.0.1:6379:6379 redis:7
```

> [!NOTE]
> インターネットに直接晒さないでください。Spica と同じホストなら `127.0.0.1` にだけ開けます。
> 別ホストに置く場合は `requirepass` と TLS を設定し、`rediss://` で繋いでください。
> **Spica が使うのは、レート制限のカウンタ・Pub/Sub・ロックだけです。** 消えても困らない情報なので、
> 永続化（RDB / AOF）は必須ではありません（設定を変えるなら要件に合わせてどうぞ）。

### 2. `.env` に接続先を書く

```bash
# Redis（任意）。未設定なら今までどおりインメモリで動きます
REDIS_URL=redis://127.0.0.1:6379

# 同じ Redis を複数のノードで共有する場合は、ノードごとに分ける
# REDIS_PREFIX=spica

# パスワードあり / TLS（値はプレースホルダの例です）
# REDIS_URL=redis://:password@127.0.0.1:6379
# REDIS_URL=rediss://:password@redis.example.com:6380/0
```

- 設定は `REDIS_URL` と `REDIS_PREFIX` の 2 つだけです（[CONFIGURATION.md](CONFIGURATION.md)）。
- **同じノードの全プロセスで同じ値を**使ってください。`REDIS_PREFIX` が違うと、別のノードとして扱われます。

### 3. 起動して確認する

```bash
npm start
```

うまく繋がると、起動ログに次が出ます:

```
[Redis] ✅ 接続しました（prefix: spica）
```

`/health` でも見えます（`configured` が設定の有無、`ready` が実際に使えるか）:

```bash
curl -s localhost:3000/health | jq .redis
# { "configured": true, "ready": true, "prefix": "spica" }
```

`sseClients` も一緒に返るので、リアルタイム接続が何本あるかも分かります。

### 4. 複数プロセスで動かす

```bash
# PM2 の cluster モード（同じホストで複数プロセス）
pm2 start npm --name "spica" -i 2 -- run start
```

別のホストに分ける場合は、前段のロードバランサ（nginx など）で振り分けます。

> [!WARNING]
> 複数プロセスにするときは、次を守ってください。
>
> - **DB は PostgreSQL にしてください。** SQLite は 1 プロセスからの書き込みを前提にしています
>   （`DB_DRIVER=postgres DATABASE_URL=...`。[POSTGRESQL.md](POSTGRESQL.md)）。
> - **メディアは Cloudflare R2 / S3 に置いてください**（`S3_*`）。別々のホストで動かすと、
>   ローカルディスクのアップロードは共有されません。
> - **`REDIS_PREFIX` はノードごとに変えてください**（同じ Redis を複数の Spica で共有する場合）。

### 5. 動いていることを確かめる

```bash
# レート制限が共有されている（20 回で 429 になり、その状態は再起動しても続く）
for i in $(seq 1 21); do
  curl -s -o /dev/null -w "%{http_code}\n" -X POST localhost:3000/api/auth/login \
    -H 'Content-Type: application/json' -d '{"username":"nobody","password":"x"}'
done | tail -1        # 429

# リアルタイム更新がプロセスをまたぐ（片方で開いて、もう片方で投稿すると届く）
curl -N localhost:3000/api/streaming
```

自動の検査も用意してあります（別プロセスと共有できているかまで見ます）:

```bash
TEST_REDIS_URL=redis://127.0.0.1:6379 npx tsx scripts/test-redis.ts
# 40 項目。接続・共有カウンタ・Pub/Sub・ロック・設定通知・fail-soft・越境配信
```

`bash scripts/run-suites.sh redis` でも同じ検査が走ります（`.env` の `TEST_REDIS_URL` を読みます）。

### 6. やめるとき

`.env` から `REDIS_URL` を消して再起動するだけです。インメモリの実装に戻ります
（プロセスは 1 つに戻してください）。

---

## ⚠️ 制限と、そうなっている理由

- **Pub/Sub は履歴を持ちません。** 配信の瞬間に繋がっていないクライアントには届きません。
  これは Redis なしのときと同じ性質です（クライアントは再接続時に取り直します）。
- **配送の並列化に Redis は使いません。** 配送は 1 件ずつ「自分が送る」と宣言（条件付き UPDATE）してから送るので、
  Redis のロックが無くても二重送信になりません（`DELIVERY_CONCURRENCY` で同時実行数を決めます）。
- **ジョブキューも Redis ではありません。** 汎用の背景処理は DB の `jobs` テーブルで動きます
  （複数プロセスでも条件付き UPDATE で 1 つだけが実行します）。
- **タイムラインのキャッシュは Redis を使います（任意・既定は無効）。** `TIMELINE_CACHE_TTL_SEC` を設定すると、
  `REDIS_URL` があれば全プロセスで共有、無ければプロセス内のキャッシュになります。有効にすると
  ブロック・削除・フォローの反映が TTL ぶん遅れる点に注意してください（利用者ごとに分かれているので漏れはしません）。
- **Redis が落ちても、ノードは落ちません。** レート制限はその場でインメモリに戻り、
  リアルタイム更新は自プロセス内だけに配ります。復帰すれば自動で戻ります（再接続は最大 5 秒間隔で再試行）。

---

## 🔧 うまくいかないとき

| 症状 | 見るところ |
| :--- | :--- |
| `/health` が `configured: true, ready: false` | 接続できていません。起動ログの `[Redis] ⚠️ 接続エラー` を確認（URL・パスワード・TLS・ファイアウォール） |
| 起動はするが、しばらくして繋がる | 起動時に Redis が無くてもノードは起動します。あとから立ち上げれば自動で繋がります |
| プロセス間でリアルタイム更新が届かない | `REDIS_PREFIX` が全プロセスで同じか。`/health` の `prefix` を突き合わせる |
| 429 が早すぎる／厳しすぎる | 共有カウンタが効いています（正常）。上限は `server/src/index.ts` の `rateLimit()` にあります |
| 設定変更が片方のプロセスに反映されない | 管理画面（API）経由の変更か確認。`server_settings` を直接書き換えた場合は通知が飛びません |

---

## 📚 関連

- [SCALE.md](SCALE.md) — 規模の限界と、次にやるべき設計変更（Redis はその 1 段目）
- [CONFIGURATION.md](CONFIGURATION.md) — 環境変数の一覧（`REDIS_URL` / `REDIS_PREFIX`）
- [POSTGRESQL.md](POSTGRESQL.md) — 複数プロセスにするときの DB
- [SETUP.md](SETUP.md) — 本番の設置手順（PM2 / nginx / R2）
