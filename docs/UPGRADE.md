# 🔄 Spica バージョンアップ・アップデート手順書 (UPGRADE.md)

本ドキュメントでは、稼働中の Spica ノードを最新バージョンへ安全に更新・マイグレーションする手順を説明します。

---

## ⚠️ 更新前の推奨事項: データベースのバックアップ

安全な運用のために、アップデート作業前に必ず SQLite データベースおよび環境設定ファイルのバックアップを作成してください。

> [!IMPORTANT]
> **稼働中の SQLite を `cp` するだけでは、直近の書き込みが失われることがあります。**
> Spica は WAL モードで動いており、**書き込みはまず `-wal` ファイルに入ります**（本体へ反映されるのは
> チェックポイント時です）。ノードを止めずに本体ファイルだけをコピーすると、`-wal` に残っている
> 書き込みはコピーに含まれません（実測: 接続を開いたまま数件書き込んだ状態で本体だけを `cp` すると、
> コピー側にはその書き込みが入っていませんでした）。
> **下の「方法 A（推奨）」を使ってください。**

### 方法 A: 付属のバックアップを使う（推奨・稼働中でも安全）

`db:maintenance` のバックアップは SQLite の `VACUUM INTO` を使い、**WAL の内容も含めた一貫性のある
1 ファイル**を書き出します。ノードを止める必要はありません。

```bash
cd /var/www/spica

# 予約投稿の整理・古いリモート投稿の削除・VACUUM もまとめて実行されます（既定はドライラン）
#   まず内容を確認したいときは --apply を外して実行してください
npm run db:maintenance -- --apply

# 書き出されたバックアップ（既定 3 世代を保持）
ls -lt server/data/backups/ | head -3

# 環境設定ファイルのバックアップ
cp .env .env.bak_$(date +%Y%m%d_%H%M%S)
```

`db:maintenance` を使いたくない場合は 3 点セットでコピーします（**本体・`-wal`・`-shm` の 3 つ**）。

```bash
cd /var/www/spica/server

# WAL の内容を本体へ反映してからコピーすると安全（sqlite3 が無い場合は 3 ファイルをまとめてコピー）
sqlite3 data_astrabit.sqlite "PRAGMA wal_checkpoint(TRUNCATE);" 2>/dev/null || true
cp data_astrabit.sqlite data_astrabit.sqlite-wal data_astrabit.sqlite-shm ~/spica-backups/ 2>/dev/null
cp -r data/uploads ~/spica-backups/uploads-$(date +%Y%m%d) 2>/dev/null || true
cp ../.env ~/spica-backups/.env-$(date +%Y%m%d)
```

---

## 🚀 通常のアップデート手順 (3ステップ)

Spica は自動マイグレーション設計を採用しているため、更新手順は非常にシンプルです。

### 1. 最新コードの取得
```bash
cd /var/www/spica

# リポジトリから最新の更新を取得
git pull origin main
```

### 2. 依存関係の更新と再ビルド
新機能のライブラリ更新やフロントエンド・バックエンドの再ビルドを行います。

```bash
# パッケージの更新
npm install

# 本番用ビルドの実行
npm run build
```

### 3. プロセスの再起動

#### PM2 を利用している場合:
```bash
# ゼロダウンタイム再起動 (reload) または 通常再起動 (restart)
pm2 reload spica

# ログを監視して起動を確認
pm2 logs spica --lines 30
```

#### systemd を利用している場合:
```bash
# サービスの再起動
sudo systemctl restart spica

# 状態確認
sudo systemctl status spica
```

---

## 📦 git を使わずに配置している場合（フォルダをコピーして設置したとき）

`git clone` ではなく、アーカイブやフォルダのコピーで配置している場合は `git pull` が使えません。
その場合は、**GitHub のアーカイブを上書きで重ねてから再ビルド**します（やっていることは
「最新のソースに置き換える」というだけです）。

```bash
cd /opt/spica            # ← 実際の配置先に読み替えてください

# 1. バックアップ（DB は WAL を含む 1 ファイル。稼働中でOK）
npm run db:maintenance -- --apply
cp .env .env.bak_$(date +%Y%m%d_%H%M%S)

# 2. 最新のアーカイブを取得して重ねる
curl -L -o /tmp/spica.tar.gz https://github.com/Keychrom/Spica/archive/refs/heads/main.tar.gz
tar xzf /tmp/spica.tar.gz --strip-components=1

# 3. 依存とビルド
npm install && npm run build

# 4. 再起動（PM2 / systemd のどちらか）
pm2 reload spica         # または sudo systemctl restart spica
```

> [!NOTE]
> - アーカイブには**ソースとドキュメントだけ**が入っています。`.env`・DB・`data/uploads`・
>   `node_modules` は含まれないので、重ねても消えません（心配なら更新前に `md5sum .env server/data_astrabit.sqlite`
>   などで控えを取ってください。上の手順 1 で DB のバックアップは取っています）。
> - 逆に、**上流で削除されたファイルはそのまま残ります**。完全に一致させたい場合は、別の場所で
>   `git clone` してから `rsync -a --delete --exclude '.env' --exclude 'node_modules' --exclude 'data' --exclude 'server/data*' クローン先/ 配置先/`
>   のように同期してください。
> - 2 回目以降は同梱の `scripts/update-by-copy.sh` が手順 1〜3 をまとめて実行します
>   （`--verify-url http://localhost:<ポート>` を付けると再起動後の確認まで行います）。

---

## 🗄️ データベースマイグレーションについて

Spica は起動時に自動的にデータベーススキーマを検査し、新規テーブルの作成や必要なカラムの追加（`ALTER TABLE`）を**自動的に実行**します。

そのため、管理者が手動で SQL コマンドやマイグレーションスクリプトを実行する必要はありません。プロセス再起動時に最新状態へと安全に移行されます。

---

## 🛠️ 新しい設定項目の確認

メジャーバージョンアップなどで新しい設定項目が追加されている場合があります。  
`.env.example` の差分を確認し、必要に応じて `.env` に項目を追加してください。

```bash
# サンプル設定ファイルとの差分を確認
diff -u .env .env.example
```

> [!IMPORTANT]
> **署名検証が有効になったことによる影響**
> アップデート後は、受信した Activity の HTTP Signature 検証が有効になります（`INBOX_SIGNATURE_MODE=strict`、既定）。
> これまで検証せずに受理していた Activity が拒否される可能性があるため、更新後しばらくはサーバーログに `[Inbox Rejected]` が出ていないか確認してください。
> 連合が停止した場合は、原因を切り分けるまでの暫定措置として `.env` に `INBOX_SIGNATURE_MODE=log` を設定して再起動してください（**署名検証が無効になるため、原因判明後は速やかに `strict` へ戻してください**）。

主な追加項目:

| 環境変数名 | デフォルト値 | 説明 |
| :--- | :--- | :--- |
| `INBOX_SIGNATURE_MODE` | `strict` | 署名検証に失敗した Activity を 401 で拒否（`log` は従来挙動・非推奨） |
| `INBOX_FORWARDED_ACTIVITY_POLICY` | `relay` | 管理パネルで承認済みのリレーからの代理転送のみ許可 |
| `SIGNATURE_MAX_AGE_SECONDS` | `43200` | 署名 `Date` ヘッダーの許容幅（秒）。リプレイ対策 |
| `ALLOW_PRIVATE_REMOTE_FETCH` | `https` 公開時は `false` | プライベート IP への remote actor 取得の可否（SSRF 対策） |

詳細は [設定リファレンス (CONFIGURATION.md)](CONFIGURATION.md) を参照してください。

> [!NOTE]
> `DOMAIN` は署名検証の `host` 候補としても使われます。実際の公開ホスト名と一致していない場合、すべての受信 Activity が署名検証に失敗し連合が停止します。

---

## 🚨 トラブルシューティング ＆ ロールバック

もしアップデート後に起動エラーや不具合が発生した場合は、以下の手順で速やかに前のバージョンへ戻すことができます。

### 1. ログの確認
```bash
# PM2 の場合
pm2 logs spica --err

# systemd の場合
journalctl -u spica -n 50 --no-pager
```

### 2. ロールバック手順
```bash
cd /var/www/spica

# 直前のコミットまたは特定のタグに戻す
git reset --hard HEAD@{1}

# 依存関係とビルドを再実行
npm install
npm run build

# プロセスを止めてから、バックアップしたデータベースを復元する
pm2 stop spica
rm -f server/data_astrabit.sqlite-wal server/data_astrabit.sqlite-shm   # ← 重要
cp ~/spica-backups/data_astrabit.sqlite server/data_astrabit.sqlite     # 方法 A で取った 1 ファイル
# 3 点セットで取った場合は -wal / -shm も一緒に戻す（古い -wal だけを残さない）
#   cp ~/spica-backups/data_astrabit.sqlite-wal server/data_astrabit.sqlite-wal

pm2 restart spica
```

> [!IMPORTANT]
> **復元するときは、先に `-wal` / `-shm` を消してください。** 古い DB 本体だけを戻して新しい `-wal` が
> 残っていると、SQLite が**戻す前の書き込みを古い DB に適用してしまいます**（復元したつもりで復元できていません）。
> サービスを止めてから、`-wal` / `-shm` を消して、DB を戻す、の順で行ってください。

---

## ✅ アップデート後の確認

1. **再起動が必要です。** DB のマイグレーションは起動時に実行されるため、新しい機能は再起動後に有効になります。
2. **本番ビルドを更新してください。** `npm run build` を実行してから再起動します（クライアントは `client/dist` から配信されます）。
3. **新しいコードが動いているか確かめます。** 次の 3 つで判断できます（いずれもログイン不要）。

   | 確認 | 期待 | 古いプロセスのとき |
   | :--- | :--- | :--- |
   | `curl -i http://<ホスト>/robots.txt` | `Content-Type: text/plain` で `Sitemap:` の行がある | `text/html`（SPA の HTML）が返る |
   | `curl -i http://<ホスト>/sitemap.xml` | `Content-Type: application/xml` | `text/html` が返る |
   | `curl -i http://<ホスト>/metrics` | `METRICS_TOKEN` 未設定なら **404 JSON**、設定済みなら 401 | `text/html` が返る |

   「HTML が返る」＝ SPA のフォールバックが応答している＝**プロセスがまだ古い**ということです。
4. **共有リンクが直っているか確かめます。** 投稿の「共有」でコピーした URL を開くと、その投稿が開きます
   （ローカル投稿は `/users/<id>/posts/<postId>` の形になります）。ブラウザの開発者ツールや
   `curl -H 'Accept: text/html' <URL>` で `og:title` が入っていることも確認できます。
5. **DB の整理をときどき実行してください。** `npm run db:maintenance` でドライラン、問題なければ `--apply` で実行します（バックアップ・古いリモート投稿の削除・VACUUM）。詳しくは [SETUP_Normal.md](SETUP_Normal.md) を参照してください（PostgreSQL の場合は手動 CLI ではなく自動メンテナンスと `npm run db:pg:backup` を使います。[SETUP_PostgreSQL_Redis.md](SETUP_PostgreSQL_Redis.md)）。
6. **動画サムネイル（任意）**: ffmpeg をインストールすると動画のサムネイルが生成されます（未インストールでも動作に支障はありません）。
7. 追加・変更された機能は [FEATURES.md](FEATURES.md)、環境変数は [CONFIGURATION.md](CONFIGURATION.md) にまとまっています。
