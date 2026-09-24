# 🔄 Spica バージョンアップ・アップデート手順書 (UPGRADE.md)

本ドキュメントでは、稼働中の Spica ノードを最新バージョンへ安全に更新・マイグレーションする手順を説明します。

---

## ⚠️ 更新前の推奨事項: データベースのバックアップ

安全な運用のために、アップデート作業前に必ず SQLite データベースおよび環境設定ファイルのバックアップを作成してください。

```bash
cd /var/www/spica

# 現在の日時を付与してデータベースをバックアップ
cp data_astrabit.sqlite data_astrabit.sqlite.bak_$(date +%Y%m%d_%H%M%S)

# 環境設定ファイルのバックアップ
cp .env .env.bak_$(date +%Y%m%d_%H%M%S)
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
# 直前のコミットまたは特定のタグに戻す
git reset --hard HEAD@{1}

# 依存関係とビルドを再実行
npm install
npm run build

# 必要に応じてバックアップしたデータベースを復元
cp data_astrabit.sqlite.bak_<日時> data_astrabit.sqlite

# プロセス再起動
pm2 restart spica
```

---

## ✅ アップデート後の確認

1. **再起動が必要です。** DB のマイグレーションは起動時に実行されるため、新しい機能は再起動後に有効になります（新しいエンドポイントが 404 を返す場合は、まだ古いプロセスが動いています）。
2. **本番ビルドを更新してください。** `npm run build` を実行してから再起動します（クライアントは `client/dist` から配信されます）。
3. **DB の整理をときどき実行してください。** `npm run db:maintenance` でドライラン、問題なければ `--apply` で実行します（バックアップ・古いリモート投稿の削除・VACUUM）。詳しくは [SETUP_Normal.md](SETUP_Normal.md) を参照してください（PostgreSQL の場合は手動 CLI ではなく自動メンテナンスと `npm run db:pg:backup` を使います。[SETUP_PostgreSQL_Redis.md](SETUP_PostgreSQL_Redis.md)）。
4. **動画サムネイル（任意）**: ffmpeg をインストールすると動画のサムネイルが生成されます（未インストールでも動作に支障はありません）。
5. 追加・変更された機能は [FEATURES.md](FEATURES.md)、環境変数は [CONFIGURATION.md](CONFIGURATION.md) にまとまっています。
