# 🛠️ 設置ガイド（PostgreSQL + Redis 構成） — 複数プロセスで動かす

> ⚠️ **現在は Alpha 版の開発中ソフトウェアです。実運用（本番環境での利用）は想定されていません。**
>
> ⚠️ **本ドキュメントに記載されている手順は、理論上可能な手順を書いているだけであり、実際に導入可能かどうかなどは一切検証していません。**

**この構成は「大人数（数百人〜）」を狙う場合の手順です。** ただし作者はこの規模で運用した経験がなく、
負荷をかけた検証もしていません（[規模と安定性について (SCALE.md)](SCALE.md)）。
**まずは [通常構成 (SETUP_Normal.md)](SETUP_Normal.md) で始めて、必要になってから移すのがおすすめです。**

| | 通常構成 | この構成（PostgreSQL + Redis） |
| :--- | :--- | :--- |
| データベース | SQLite（ファイル 1 つ） | PostgreSQL（同時書き込み・複数プロセスで共有） |
| レート制限 | プロセスごとに数える | Redis で全プロセス共有 |
| リアルタイム更新（SSE） | 接続したプロセスの利用者だけ | Redis の Pub/Sub で全プロセスへ |
| 設定の変更 | 起動時に読んだきり | 変更を全プロセスへ通知して読み直す |
| 定期処理（予約投稿・配送再送） | そのプロセスが実行 | ロックを取った 1 プロセスだけが実行 |
| プロセス数 | 1 | 複数（ロードバランサ / PM2 cluster） |
| メディア | ローカルディスクでも可 | **R2 / S3 が前提**（ホストをまたぐと共有されない） |

> [!IMPORTANT]
> Redis は「複数プロセスで動かすための鍵」であって、それ自体でアプリの処理能力が上がるわけではありません。
> **DB を SQLite のままにすると、複数プロセスでの書き込みが詰まります。** DB と Redis はセットで考えてください。

---

## 🗺️ 手順の全体像

1. **[通常構成 (SETUP_Normal.md)](SETUP_Normal.md) のステップ 1〜3 を済ませる**（Node.js / ソース配置 / リバースプロキシ）
2. PostgreSQL を入れて、ロールと DB を作る（この文書の 1 章）
3. 既存データを移送する（SQLite から。新規なら不要）→ 2 章
4. Redis を入れる → 3 章
5. `.env` を切り替える → 4 章
6. 起動して確認する → 5 章
7. プロセスを増やす → 6 章
8. メディアを R2 / S3 へ（通常構成のステップ 5）
9. 運用（バックアップは `pg_dump`、メンテナンスは自動）→ 7 章

---

## 1. 🐘 PostgreSQL を用意する

```bash
sudo apt update && sudo apt install -y postgresql
sudo systemctl enable --now postgresql

# アプリ用のロールと DB を作る（アプリに superuser は使わせない）
sudo -u postgres psql <<'SQL'
CREATE ROLE spica LOGIN PASSWORD 'ここに強いパスワード';
CREATE DATABASE spica OWNER spica;
SQL

# 任意: 日本語の部分一致検索を速くする索引（管理者権限が要る作業・1 回だけ）
sudo -u postgres psql -d spica -c 'CREATE EXTENSION IF NOT EXISTS pg_trgm'
```

- **`pg_trgm` は無くても起動します**（適用時に警告が出るだけ。検索は遅くなります）。
- 詳細な設計・方言の話は [PostgreSQL 対応 (POSTGRESQL.md)](POSTGRESQL.md) にまとめています。

---

## 2. 📦 既存データを移送する（SQLite から）

> [!IMPORTANT]
> 移送は**サーバーを止めて**行ってください。切り替えの間だけ書き込みを止めます。

```bash
cd /var/www/spica
pm2 stop spica

# スキーマを生成して適用する
npm run db:pg:schema
export DATABASE_URL='postgres://spica:パスワード@127.0.0.1:5432/spica'
npm run db:pg:init -- --dsn "$DATABASE_URL"

# データを移送して、行数と内容を突き合わせる
npm run db:pg:migrate -- --from data_astrabit.sqlite --dsn "$DATABASE_URL" --truncate --verify
```

- `--verify` は**行数と内容の要約（チェックサム）を突き合わせます**。合わない行があれば失敗として出ます。
- 18 万行で 12 秒程度が目安です。
- 移送されないもの: メディアの実体（R2 / S3 にあるか、ローカルのまま使います）・画像プロキシのキャッシュ（再生成されます）。
- **失敗したら `.env` を戻せば元に戻ります。** SQLite ファイルは消さないでください（切り戻し用）。

---

## 3. 🔌 Redis を用意する

```bash
sudo apt install -y redis-server
sudo systemctl enable --now redis-server
redis-cli ping        # PONG が返れば OK
```

Docker を使う場合:

```bash
docker run -d --name spica-redis --restart unless-stopped \
  -p 127.0.0.1:6379:6379 redis:7
```

- **インターネットに直接晒さないでください。** 同じホストなら `127.0.0.1` にだけ開けます。別ホストなら `requirepass` と TLS（`rediss://`）を設定します。
- Spica が使うのはレート制限のカウンタ・Pub/Sub・ロックだけなので、**永続化（RDB / AOF）は必須ではありません**。
- くわしくは [Redis を使う (REDIS.md)](REDIS.md) を参照してください。

---

## 4. ⚙️ `.env` を切り替える

```env
PORT=3000
BIND_HOST=127.0.0.1
DOMAIN=spica.example.com
PROTOCOL=https
INSTANCE_NAME=Spica
INSTANCE_DESCRIPTION=My sovereign Spica node.

# --- データベース: PostgreSQL ---
DB_DRIVER=postgres
DATABASE_URL=postgres://spica:パスワード@127.0.0.1:5432/spica
# 同時に張る接続の上限（既定 5）。プロセスを増やすなら合計が DB の許容範囲に収まるように
DATABASE_POOL_MAX=5

# --- Redis（複数プロセスで動かすために必要）---
REDIS_URL=redis://127.0.0.1:6379
# 同じ Redis を複数の Spica で共有する場合は、ノードごとに変える
REDIS_PREFIX=spica

# --- メディア（複数プロセス・複数ホストでは必須）---
S3_ENDPOINT=https://<あなたのAccount_ID>.r2.cloudflarestorage.com
S3_BUCKET=spica-media
S3_REGION=auto
S3_ACCESS_KEY_ID=<発行されたAccess_Key_ID>
S3_SECRET_ACCESS_KEY=<発行されたSecret_Access_Key>
S3_PUBLIC_URL=https://media.example.com
```

> [!WARNING]
> `DATABASE_URL` と `REDIS_URL` は**パスワードを含みます**。公開リポジトリにコミットしないでください
> （`npm run check:secrets` が検出します。`.env` は元から追跡対象外です）。

---

## 5. ✅ 起動して確認する

まずは **1 プロセス**で起動して、DB と Redis が繋がっていることを確かめます。

```bash
npm run build
pm2 start npm --name "spica" -- run start

# DB と Redis の状態を見る
curl -s localhost:3000/health | jq '{status, db, redis}'
# {
#   "status": "ok",
#   "db": { "ok": true, "latencyMs": 2 },
#   "redis": { "configured": true, "ready": true, "prefix": "spica" }
# }
```

確認する項目:

| 項目 | 期待 |
| :--- | :--- |
| `redis.ready` | `true`（`false` なら起動ログの `[Redis] ⚠️` を確認。繋がらなくてもノードは動きます） |
| タイムライン | 移送したデータが表示される |
| 検索 | 日本語で検索できる（順位は `published_at` の近似。詳細は [POSTGRESQL.md](POSTGRESQL.md)） |
| 投稿 | 新規投稿できて、タイムラインに出る |
| 連合 | [SETUP_Normal.md の「Inbox 署名検証の確認」](SETUP_Normal.md) と同じ手順で 401 と WebFinger を確認 |
| レート制限 | 同じ IP から 21 回叩いて、最後が `429` になる（下のコマンド） |

```bash
# 認証系のレート制限（既定 20 回/分）に当たるか。最後が 429 なら効いています
for i in $(seq 1 21); do
  curl -s -o /dev/null -w "%{http_code}\n" -X POST localhost:3000/api/auth/login \
    -H 'Content-Type: application/json' -d '{"username":"nobody","password":"x"}'
done | tail -1
```

---

## 6. 🧵 プロセスを増やす

DB と Redis が繋がっていることを確認できたら、プロセスを増やせます。

### 方法 1: PM2 の cluster モード（同じホストで増やす）

```bash
pm2 delete spica
pm2 start npm --name "spica" -i 2 -- run start    # -i 2 = 2 プロセス
pm2 save
```

PM2 が 1 つのポートで受け持つので、**nginx の設定はそのままで構いません**（`127.0.0.1:3000` のまま）。

### 方法 2: systemd + nginx（ホストを分ける / 手動で並べる）

`/etc/systemd/system/spica@.service`（テンプレート）：

```ini
[Unit]
Description=Spica ActivityPub Node (instance %i)
After=network.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/var/www/spica
# インスタンス番号をポートにする（spica@0 → 3000、spica@1 → 3001）
# `env` で渡した値は .env より優先されます（dotenv は既存の環境変数を上書きしない）
ExecStart=/usr/bin/env PORT=300%i /usr/bin/npm run start
Restart=always
RestartSec=10
Environment=NODE_ENV=production
StandardOutput=syslog
StandardError=syslog
SyslogIdentifier=spica

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now spica@0 spica@1
```

`/etc/nginx/sites-available/spica` の `location /` を upstream に変えます：

```nginx
upstream spica_backend {
    server 127.0.0.1:3000;
    server 127.0.0.1:3001;
    keepalive 16;
}

server {
    server_name spica.example.com;
    client_max_body_size 50M;
    # 転送量を減らす（アプリも gzip して返しますが、nginx が直接返すものにも掛けておくと確実です）
    gzip on;
    gzip_types text/plain text/css application/javascript application/json application/manifest+json image/svg+xml;
    gzip_min_length 1024;
    gzip_vary on;

    location / {
        proxy_pass http://spica_backend;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # SSE（リアルタイム更新）をバッファリングしない
        proxy_buffering off;
        proxy_read_timeout 300s;
    }
}
```

> [!WARNING]
> 複数プロセスにするときの注意:
>
> - **`REDIS_PREFIX` は同じノードの全プロセスで同じ値**にしてください（別の Spica と共有するときは分ける）。
> - **メディアは R2 / S3 に**置いてください。ローカルディスクは別のホストとは共有されません。
> - `DATABASE_POOL_MAX` × プロセス数が PostgreSQL の `max_connections`（既定 100）を超えないようにします。
> - 長期の SSE 接続が増えると 1 プロセスのメモリを圧迫します。必要なら配信を別プロセスに分けます（未実装・[SCALE.md](SCALE.md)）。

> [!TIP]
> PostgreSQL 側の設定も見直してください。既定のままだと 128MB（`shared_buffers`）しか使わず、
> DB 全体がメモリに載りません。**メモリの 25% 程度**が目安です（`postgresql.conf`）。
>
> ```conf
> shared_buffers = 2GB          # メモリの 25% 程度
> effective_cache_size = 6GB    # メモリの 75% 程度
> max_parallel_workers_per_gather = 0   # 短いクエリを大量にさばくなら 0 も有効
> ```
>
> 負荷試験（[SCALE.md](SCALE.md)）では PostgreSQL を**既定のまま**測っているので、
> 上の数字はチューニング前のものです。

---

## 7. 🛠️ 運用（通常構成との違い）

| | 通常構成（SQLite） | この構成（PostgreSQL） |
| :--- | :--- | :--- |
| **バックアップ** | `VACUUM INTO`（`npm run db:maintenance` の④） | `pg_dump -Fc`（`npm run db:pg:backup`）。**既定で毎日自動**（`BACKUPS_KEEP` 世代） |
| **復元** | ファイルを差し替える | `pg_restore --clean --if-exists -d "$DATABASE_URL" <dump>` |
| **整理（保持期間の削除など）** | `npm run db:maintenance -- --apply` | **アプリ内の自動メンテナンス**が担当（`AUTO_MAINTENANCE` / `AUTO_MAINTENANCE_HOUR`）。手動 CLI は SQLite 専用です |
| **容量の解放** | FTS マージ + `VACUUM` | PostgreSQL が自動で回収（`VACUUM` を手で回す必要はありません） |
| **pg_dump が無い環境** | - | 警告してスキップします（`PG_BIN_DIR` で場所を指定できます） |

```bash
# 手動でバックアップ（既定: server/data/backups、3 世代）
npm run db:pg:backup
npm run db:pg:backup -- --out /backup --keep 5

# 復元
pg_restore --clean --if-exists -d "$DATABASE_URL" server/data/backups/spica-YYYYMMDD-HHMMSSmmm.dump
```

監視は通常構成と同じです（`/health`。認証ヘッダーを付けると配送キューの滞留なども見えます）。

---

## 8. ↩️ 通常構成に戻す（切り戻し）

```bash
pm2 stop spica
# .env から DB_DRIVER / DATABASE_URL / REDIS_URL を消す（またはコメントアウト）
pm2 delete spica
pm2 start npm --name "spica" -- run start
```

SQLite ファイルを消していなければ、そのまま元のデータで動きます。

---

## 9. ⚠️ この構成でも残る制限

- **配送は並列に送れますが、上限は相手サーバー次第です。** 1 件ずつ「自分が送る」と宣言してから送るので
  二重送信にはなりません（`DELIVERY_CONCURRENCY`、既定 5）。ただし相手が遅いとそこが上限になります。
- **検索の順位は近似**です（`bm25` の代わりに `published_at`）。
- **タイムラインのキャッシュを使いたい場合は明示的に有効化**します（`TIMELINE_CACHE_TTL_SEC`、既定 0 = 無効）。
  読み取りが重いと感じたら 15〜30 秒あたりから試してください。Redis を入れているので全プロセスで共有されます
  （`/health` の `timelineCache` でヒット率が見えます）。ブロック・削除の反映が TTL ぶん遅れる点は許容してください。
- **複数プロセスでの大人数の検証は、まだ誰もしていません。** 兆候（どこが詰まるか）を自分で見られるように、
  まずは `/health`（`redis` / `sseClients` / `timelineCache` / `deliveryQueue` / `jobs`）と
  `npm run db:pg:stats`（遅いクエリ・テーブルと索引のサイズ）を見てください。

---

## 📚 関連

- [通常構成 (SETUP_Normal.md)](SETUP_Normal.md) — まずこちら（Node.js / nginx / PM2 / R2 / 運用の共通部分）
- [規模と安定性について (SCALE.md)](SCALE.md) — なぜ大人数に向かないのか、次に何をすべきか
- [PostgreSQL 対応 (POSTGRESQL.md)](POSTGRESQL.md) — 設計・移行・制約の詳細
- [Redis を使う (REDIS.md)](REDIS.md) — Redis の導入と複数プロセスの注意点
- [設定リファレンス (CONFIGURATION.md)](CONFIGURATION.md) — 環境変数の一覧
