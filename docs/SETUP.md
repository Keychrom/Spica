# 🛠️ Spica サーバー設置・導入ガイド (SETUP.md)

> ⚠️ **現在は Alpha 版の開発中ソフトウェアです。実運用（本番環境での利用）は想定されていません。**
>
> ⚠️ **本ドキュメントに記載されている手順は、理論上可能な手順を書いているだけであり、実際に導入可能かどうかなどは一切検証していません。**

本ドキュメントでは、Ubuntu などの Linux サーバー環境において、Spica を本番運用するための環境構築、リバースプロキシ設定、SSL化、および常駐化手順を詳しく解説します。

---

## 📋 システム要件

| 項目 | 推奨スペック | 最小スペック |
| :--- | :--- | :--- |
| **OS** | Ubuntu 22.04 / 24.04 LTS | 各種 Linux, macOS, Windows |
| **CPU** | 2コア以上 | 1コア |
| **メモリ (RAM)** | 2GB 以上 | 1GB |
| **ストレージ** | SSD 20GB 以上 (メディア保存量による) | SSD 10GB |
| **Node.js** | v20.x または v22.x LTS (v24も対応) | v20.0.0+ |
| **外部通信** | ポート 80 / 443 (HTTPS 必須) | - |
| **ドメイン** | 独自ドメイン (例: `spica.example.com`) | - |

> [!IMPORTANT]
> ActivityPub（Fediverse）では、他サーバーとの相互通信において **HTTPS (SSL/TLS)** が必須要件となります。必ず有効な SSL 証明書をご用意ください。

---

## 🚀 ステップ 1: Node.js のインストール

Node.js v20 または v22 LTS をインストールします（NodeSource を利用する例）：

```bash
# パッケージリスト更新と必要ツールのインストール
sudo apt update && sudo apt install -y curl git build-essential

# Node.js 22.x リポジトリの追加
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -

# Node.js のインストール
sudo apt install -y nodejs

# バージョン確認 (v20.0.0 以上であることを確認)
node -v
npm -v
```

---

## 🚀 ステップ 2: ソースコードの配置とビルド

```bash
# アプリケーション配置ディレクトリを作成 (例: /var/www/spica)
sudo mkdir -p /var/www/spica
sudo chown -R $USER:$USER /var/www/spica

# リポジトリのクローン
git clone https://github.com/Keychrom/Spica.git /var/www/spica
cd /var/www/spica

# 依存関係のインストール
npm install

# 環境設定ファイルの作成
cp .env.example .env
nano .env
```

### `.env` の編集例:
```env
PORT=3000
BIND_HOST=127.0.0.1
DOMAIN=spica.example.com
PROTOCOL=https
INSTANCE_NAME=Spica
INSTANCE_DESCRIPTION=My sovereign Spica node.
DB_PATH=data_astrabit.sqlite
```

### プロダクションビルドの実行:
```bash
# フロントエンドおよびバックエンドをビルド
npm run build
```

---

## 🚀 ステップ 3: リバースプロキシの設定

Spica バックエンドは通常 `127.0.0.1:3000` で待受を行います。  
外部からの HTTPS (443) リクエストを受け取るため、Nginx または Cloudflare Tunnel を前段に配置します。

### パターン A: Nginx + Let's Encrypt (標準構成)

#### 1. Nginx と Certbot のインストール
```bash
sudo apt install -y nginx certbot python3-certbot-nginx
```

#### 2. Nginx 設定ファイルの作成
`/etc/nginx/sites-available/spica` を作成します：

```nginx
server {
    server_name spica.example.com;

    # メディアアップロード用の最大ファイルサイズ
    client_max_body_size 50M;

    # リクエストログ
    access_log /var/log/nginx/spica.access.log;
    error_log /var/log/nginx/spica.error.log;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;

        # WebSocket サポート (タイムラインのリアルタイム更新)
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";

        # プロキシヘッダーの転送
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        proxy_buffering off;
        proxy_read_timeout 300s;
        proxy_connect_timeout 300s;
    }
}
```

#### 3. 有効化と SSL 証明書の取得
```bash
sudo ln -s /etc/nginx/sites-available/spica /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx

# Let's Encrypt で無料の SSL 証明書を自動発行・適用
sudo certbot --nginx -d spica.example.com
```

---

### パターン B: Cloudflare Tunnel (ポート開放不要・推奨)

ルーターのポート開放ができない自宅サーバー等の場合、Cloudflare Tunnel（`cloudflared`）を使用することで、安全に全世界へ公開できます。

1. Cloudflare Zero Trust ダッシュボードで Tunnel を作成。
2. ドメイン（例: `spica.example.com`）の転送先 Service に `http://localhost:3000` を指定。
3. `Additional application settings` で HTTP Host Header を `spica.example.com` に設定。

> [!NOTE]
> 手順 3 の HTTP Host Header は、Spica 側で `.env` の `DOMAIN` を署名検証の `host` 候補として使用するため、**省略しても動作します**。  
> ただし `DOMAIN` が実際の公開ホスト名と一致していない場合、受信した Activity の HTTP Signature 検証がすべて失敗し、連合（他サーバーからの投稿受信）が停止します。

---

## 🔐 ステップ 3.5: Inbox 署名検証の確認

Spica は受信した ActivityPub の Activity を HTTP Signature で検証し、失敗したものを **401 で拒否** します（既定: `INBOX_SIGNATURE_MODE=strict`）。公開前に、署名検証が有効であることと、連合が成立していることを確認してください。

```bash
DOMAIN=spica.example.com

# 1) 署名検証が有効か（未知の Activity 種別を送るため DB は変化しません）
#    → 401 が返れば strict が有効です
curl -s -o /dev/null -w "%{http_code}\n" -X POST "https://$DOMAIN/inbox" \
  -H "Content-Type: application/activity+json" \
  -d '{"type":"SetupProbe","actor":"https://probe.invalid/users/probe"}'

# 2) WebFinger / Actor が外部から取得できるか
curl -s "https://$DOMAIN/.well-known/webfinger?resource=acct:admin@$DOMAIN"
curl -s -H "Accept: application/activity+json" "https://$DOMAIN/users/admin"
```

Fediverse（Misskey / Mastodon 等）から `@admin@spica.example.com` を検索して投稿が届けば連合は成立しています。  
投稿が届かない場合は、サーバーログの `[Inbox Rejected]` 行に拒否理由が記録されます。理由ごとの対処は [設定リファレンス (CONFIGURATION.md)](CONFIGURATION.md) の「Inbox 署名検証」を参照してください。

---

## 🚀 ステップ 4: プロセスの常駐化 (PM2 または systemd)

サーバー再起動時やクラッシュ時にも自動的に立ち上がるよう設定します。

### 方法 1: PM2 を使用する場合 (推奨・簡単)

```bash
# PM2 のグローバルインストール
sudo npm install -g pm2

# Spica の起動 (ルートディレクトリで実行)
cd /var/www/spica
pm2 start npm --name "spica" -- run start

# 自動起動の登録
pm2 save
pm2 startup
```

ログの確認:
```bash
pm2 logs spica
```

### 方法 2: systemd を使用する場合

`/etc/systemd/system/spica.service` を作成します：

```ini
[Unit]
Description=Spica ActivityPub Node
After=network.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/var/www/spica
ExecStart=/usr/bin/npm run start
Restart=always
RestartSec=10
StandardOutput=syslog
StandardError=syslog
SyslogIdentifier=spica
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

サービスを有効化して起動：
```bash
sudo systemctl daemon-reload
sudo systemctl enable spica
sudo systemctl start spica
sudo systemctl status spica
```

---

## 🚀 ステップ 5: メディアオブジェクトストレージ (Cloudflare R2)

投稿画像や添付ファイルを外部ストレージに保存したい場合、Cloudflare R2（無料枠：毎月10GB・転送量無料）が最適です。

1. Cloudflare ダッシュボードで **R2 バケット** を作成（例: `spica-media`）。
2. バケットの「設定」で **パブリックアクセス**（カスタムドメインまたは r2.dev サブドメイン）を有効化。
3. **R2 API トークン** を発行（権限: オブジェクト読み取り/書き込み）。
4. Spica の `.env` に以下を追記して再起動：

```env
S3_ENDPOINT=https://<あなたのAccount_ID>.r2.cloudflarestorage.com
S3_BUCKET=spica-media
S3_REGION=auto
S3_ACCESS_KEY_ID=<発行されたAccess_Key_ID>
S3_SECRET_ACCESS_KEY=<発行されたSecret_Access_Key>
S3_PUBLIC_URL=https://media.example.com
```

---

## 🚀 ステップ 6: 動作確認と初期管理者登録

1. ブラウザで `https://spica.example.com` を開きます。
2. 画面右上の **「新規登録」** から最初のアカウントを作成します。
3. 発行された **マスターキー** を安全なパスワードマネージャー等に保存します。
4. ※最初の登録ユーザーには自動的に管理者権限（ADMIN）が付与され、画面上部に「管理パネル」が表示されます。
5. 管理パネルから、サーバールール、利用規約、リレー設定等をお好みに合わせて設定してください。

---

## 🔒 ステップ 6.5: コミット前の秘密スキャン（公開リポジトリを使う場合）

`npm install` を実行すると、git フック（`.githooks/pre-commit`）が自動で有効になります。コミット前に `npm run check:secrets -- --staged` が走り、秘密鍵・API トークン・`.env`・SQLite・鍵素材が混ざっていればコミットを中止します。

```bash
npm run check:secrets            # 追跡ファイルを一括チェック
npm run check:secrets -- --all   # 作業ツリー全体（未追跡も含む）
git config --unset core.hooksPath   # フックを外す
```

---

## 🛠️ ステップ 7: 運用（バックアップと DB メンテナンス）

Spica は SQLite 1 ファイルで動くため、運用は「バックアップ」と「定期的な整理」の 2 つが中心になります。どちらも `npm run db:maintenance` にまとまっています。

### 7-1. まずはドライラン

```bash
cd /path/to/Spica
npm run db:maintenance
```

削除対象の件数・孤立メディア・現在のサイズが表示されます。**この時点では何も削除されません。**

### 7-2. 実行する

```bash
npm run db:maintenance -- --apply
```

実行の内容:

| 手順 | 内容 |
| :--- | :--- |
| ① リモート投稿の整理 | 保持期間（既定 30 日 / `--days N`）を過ぎたリモート投稿を削除します。ブックマーク・ピン留め・ローカル投稿の返信先/引用元・ローカルのリアクション/ブースト・ローカル投稿への返信・フォロー中アクターの投稿は残します。 |
| ② 孤立メディアの削除 | `data/uploads/` のうち、どの投稿からも参照されていないファイルを削除します（24時間以内のファイルは安全のため見送り）。S3 / R2 のオブジェクトは対象外です。 |
| ③ FTS マージ + VACUUM | FTS5 の内部セグメントをマージしてから VACUUM し、空いたページを解放します。**投稿を消しただけでは容量が戻らない**ため、この手順が容量削減の要です。 |
| ④ バックアップ | 削除の前に `VACUUM INTO` で一貫性のあるスナップショットを作成します（`server/data/backups/`、既定 3 世代）。 |
| ⑤ 保存・索引の方針を適用 | 管理画面で設定した「検索索引の範囲」「リモートブーストの保存範囲」を既存データへ遡って適用します（既定はローカル投稿のみ索引・フォロー中のブーストのみ保存）。`--skip-policy` で省略できます。 |
| ⑥ 画像プロキシのキャッシュ整理 | `server/data/proxy-cache/` の期限切れ（既定 30 日）と容量超過分（既定 512MB）を削除します。`--skip-proxy-cache` で省略できます。 |

> [!IMPORTANT]
> VACUUM は DB の排他ロックを取るため、**サーバーを停止してから実行**してください。起動中でもバックアップと投稿の削除は動きますが、VACUUM だけが失敗します（その場合は終了コード 2 で知らせます）。

> [!TIP]
> リレーに参加していると 1 日で数万件のリモート投稿が届き、DB が急速に膨らみます。`--max-remote-posts 20000` のように**件数で上限を切る**方が効く場合もあります（保持期間だけでは足りないことがあります）。

### 7-3. 定期実行（cron の例）

サーバーを止めずにできる範囲（バックアップ＋整理）を毎日回し、VACUUM は週次のメンテナンス時間に行う例です。

```bash
# 毎日 04:00 にバックアップと削除（VACUUM なし）
0 4 * * * cd /path/to/Spica && npm run db:maintenance -- --apply --no-vacuum >> logs/maintenance.log 2>&1
```

```bash
# 毎週日曜 04:30 にサーバーを止めて VACUUM まで（PM2 の例）
30 4 * * 0 cd /path/to/Spica && pm2 stop spica && npm run db:maintenance -- --apply && pm2 start spica
```

### 7-4. 復元する

バックアップは通常の SQLite ファイルなので、置き換えるだけで復元できます。

```bash
pm2 stop spica                       # または systemctl stop spica
cp server/data_astrabit.sqlite server/data_astrabit.sqlite.broken   # 念のため退避
rm -f server/data_astrabit.sqlite-wal server/data_astrabit.sqlite-shm
cp server/data/backups/data_astrabit-YYYYMMDD-HHMMSSmmm.sqlite server/data_astrabit.sqlite
pm2 start spica
```

`DB_PATH` を別ファイルに向けて起動すれば、置き換えずに中身を確認することもできます。

### 7-5. 動画サムネイルを使う（任意）

ffmpeg を入れると、動画のサムネイルを自動生成してタイムライン表示が軽くなります。

```bash
sudo apt install ffmpeg      # Ubuntu / Debian
brew install ffmpeg          # macOS
winget install Gyan.FFmpeg   # Windows
```

未インストールでもアップロードは成功し、サムネイルが付かないだけです（機能が自動で無効になります）。実行ファイルの場所は `FFMPEG_PATH` / `FFPROBE_PATH` で指定できます。

---


### 7-6. 自動化と監視

| 仕組み | 内容 |
| :--- | :--- |
| **毎日の自動整理** | サーバー常駐のまま、既定で毎日 4 時以降に「バックアップ → 保存・索引の方針適用 → 保持期間（既定 30 日）を超えたリモート投稿の削除」を行います。`AUTO_MAINTENANCE=false` で無効、`AUTO_MAINTENANCE_HOUR` で時刻を変更できます（管理画面のダッシュボードからも操作可）。 |
| **バックアップのみ cron で** | `npm run db:maintenance -- --backup-only` でバックアップと世代管理だけを行って終了します（既定 3 世代）。 |
| **即時実行** | 管理画面 → ダッシュボード →「容量とメンテナンス」→「いますぐ整理を実行」。DB サイズ・投稿数・索引行数・ドライブ使用量・削除予定件数もここで確認できます。 |
| **外形監視** | `curl -s https://your-domain/health` が `{"status":"ok"}` を返します（DB 異常時は 503）。有効なセッショントークンを付けると詳細（DB サイズ・配送キューの滞留・自動整理の状況）も返します。UptimeRobot 等はヘッダーなしでどうぞ。 |
| **グレースフルシャットダウン** | `SIGTERM` / `SIGINT` で新規受付を止め、開いている SSE を閉じ、WAL をチェックポイントしてから終了します。systemd / PM2 からシグナルが **node プロセスに直接届く**ようにしてください（例: `ExecStart=/usr/bin/node /path/to/Spica/server/dist/index.js`）。POSIX 環境のみ有効で、Windows では強制終了になりますが、SQLite は WAL なのでデータは壊れません。 |

> [!NOTE]
> **VACUUM は自動では行いません。** 削除で空いた領域を実際にファイルサイズへ反映するには排他ロックが必要なため、月に一度などサーバーを止められるタイミングで `npm run db:maintenance -- --apply` を実行してください（FTS のマージ → VACUUM。バックアップも同時に取られます）。

---

## ⚠️ 運営方針: DM（1対1のメッセージ）は実装されません

Spica は、**ダイレクトメッセージ（DM / `specified` 公開範囲）を意図的に実装していません**。設定で有効化する項目もありません。

1対1のメッセージ機能を提供すると、ノードの運営が「他人の通信を媒介する事業」と評価されうるため、運営者（個人であっても）が電気通信事業法上の義務（電気通信事業の届出、通信の秘密の保持、秘密の漏洩防止義務など）を負うおそれがあります。趣味で運用する自前ノードという Spica の前提と両立しないため、公開範囲は **公開／ローカル限定／フォロワー限定** の3段階に限定しています。

- 利用者には、**「フォロワー限定」は DM ではない**（承認済みフォロワー全員が閲覧でき、連合先にも配信される）ことをあらかじめ案内してください。
- 運営者（あなた）はデータベースを直接参照できる立場にあるため、その旨も利用者に伝えておくことをおすすめします。
- 詳しい趣旨は [README の「DM を実装しない方針」](../README.md) を参照してください。

---
