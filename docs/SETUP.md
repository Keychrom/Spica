# 🛠️ Spica サーバー設置・導入ガイド (SETUP.md)

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
