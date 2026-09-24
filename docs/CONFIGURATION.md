# ⚙️ Spica 設定リファレンス

Spica の設定は **2 か所**に分かれています。

| 設定場所 | 内容 | 変更方法 |
| --- | --- | --- |
| `.env` ファイル | ポート・公開ドメイン・DB パス・署名検証ポリシーなど、**起動時に確定する基盤設定** | ファイルを編集してサーバー再起動 |
| SQLite の `server_settings` テーブル | インスタンス名・説明・登録モード・サーバールール・リレー・絵文字・S3 認証情報など、**運用中に変更する設定** | 管理画面（`/api/admin`）または API から変更（再起動不要） |

---

## 1. `.env` の読み込み順

`server/src/config.ts` は以下の順に `.env` を探し、**最初に見つかった 1 つ**を読み込みます。

1. `./.env`（カレントディレクトリ）
2. `../.env`（1 つ上）
3. `./server/.env`

`npm run dev` / `npm start` はサーバーの作業ディレクトリが `server/` になるため、実際には**プロジェクトルートの `.env`** が読み込まれます。

> [!IMPORTANT]
> すでに OS の環境変数として同名の項目が設定されている場合、`.env` の値では**上書きされません**（dotenv の仕様）。挙動がおかしい場合は `echo $DOMAIN` などで実環境変数を確認してください。

---

## 2. `.env` 項目一覧

### 基本設定

| 変数 | 既定値 | 説明 |
| --- | --- | --- |
| `PORT` | `3000` | 待受ポート番号 |
| `BIND_HOST` | `0.0.0.0` | 待受アドレス。リバースプロキシ配下で外部に直接公開しない場合は `127.0.0.1` を推奨 |
| `DOMAIN` | `localhost:<PORT>` | **外部公開ドメイン名（ポートを含めない）**。例: `spica.example.com` |
| `PROTOCOL` | `DOMAIN` に `localhost` を含む場合は `http`、それ以外は `https` | 外部から見た通信プロトコル |
| `DB_PATH` | `data_astrabit.sqlite` | SQLite ファイルのパス。相対パスは `server/` 基準で解決されます |
| `DB_DRIVER` | `sqlite` | `sqlite` または `postgres`。**既定は SQLite** で、書かなければ従来どおりです |
| `DATABASE_URL` | （なし） | `DB_DRIVER=postgres` のときの接続文字列。**パスワードを含むため公開リポジトリに置かないでください**（[POSTGRESQL.md](POSTGRESQL.md)） |
| `DATABASE_POOL_MAX` | `5` | PostgreSQL のコネクションプールの本数。同時に走るクエリの上限でもある。相手の DB を圧迫する場合は減らす（`1` で 1 本ずつ直列に戻る） |
| `DATABASE_STATEMENT_TIMEOUT_MS` | `30000` | PostgreSQL の 1 クエリの上限（ミリ秒。`0` で無効）。重いクエリやロック待ちが 1 本の接続を長時間占有し続けないための保険 |
| `DATABASE_IDLE_TIMEOUT_MS` | `60000` | アイドル状態のトランザクションを切るまでの時間（ミリ秒。`0` で無効）。トランザクションを握ったまま落ちた処理がロックを保持し続けるのを防ぐ |
| `PG_BIN_DIR` | （なし） | `pg_dump` / `pg_restore` のあるディレクトリ（例: `/usr/lib/postgresql/18/bin`）。PATH と標準のインストール先を探しても見つからない場合に指定する（PostgreSQL のバックアップで使う） |
| `REDIS_URL` | （なし） | **空なら Redis を使わない**（今までどおりインメモリ＝1 プロセス前提）。設定すると、レート制限・リアルタイム更新・設定の反映・定期処理の単一実行が Redis 経由になり、複数プロセスで動かせる（パスワードを含むため公開リポジトリに置かない。手順は [REDIS.md](REDIS.md)） |
| `REDIS_PREFIX` | `spica` | Redis のキー・チャンネルの接頭辞。同じ Redis を複数のノードで共有する場合に、ノードごとに変える |
| `DELIVERY_CONCURRENCY` | `5` | 配送再送の同時実行数（1〜50）。配送はネットワーク待ちが主なので、並べると同じ時間で多く送れる。相手サーバーを過度に叩かない範囲で調整する |
| `TIMELINE_CACHE_TTL_SEC` | `0` | タイムラインの読み取りキャッシュの TTL（秒。**既定 0 = 無効**）。有効にすると同じ画面を何度も開いたときの組み立てを省ける（Redis があれば全プロセスで共有、無ければプロセス内・上限 300 件）。**ブロック・削除・フォロー・サイレンスの反映が TTL ぶん遅れる**（キャッシュは利用者ごとに分かれているので、他人に漏れることはない）。`/health` の `timelineCache` でヒット率が見える |
| `INSTANCE_NAME` | `Spica` | 既定のインスタンス表示名（初回起動時に DB へ保存され、以後は管理画面の値が優先されます） |
| `INSTANCE_DESCRIPTION` | （定型文） | 既定のインスタンス説明文（同上） |

> [!WARNING]
> `DOMAIN` は **必ず実際に外部からアクセスされるホスト名と完全一致**させてください。
> Spica は HTTP Signature の検証で「署名された `host`」の候補としてこの値を使います。誤っていると、他サーバーからの配送がすべて署名検証に失敗し、連合が停止します（詳細は「[5. 署名検証](#5-inbox-署名検証-http-signature)」）。

### オブジェクトストレージ（任意）

未設定の場合は `server/data/uploads/` へローカル保存されます。

| 変数 | 説明 |
| --- | --- |
| `S3_ENDPOINT` | Cloudflare R2 / S3 互換エンドポイント |
| `S3_BUCKET` | バケット名 |
| `S3_REGION` | リージョン（R2 は `auto`） |
| `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` | 認証情報 |
| `S3_PUBLIC_URL` | 配信 URL（CDN のカスタムドメイン等） |

> [!NOTE]
> S3 設定は **管理画面から保存した値が `.env` より優先**されます（`server/src/storage.ts` の `getStorageConfig()`）。管理画面で一度保存すると、以後 `.env` を書き換えても反映されません。その場合は管理画面側を更新してください。

### 署名検証ポリシー

| 変数 | 既定値 | 説明 |
| --- | --- | --- |
| `INBOX_SIGNATURE_MODE` | `strict` | `strict`: 検証失敗を **401 で拒否**。`log`: 警告ログのみで処理続行（**非推奨**） |
| `INBOX_FORWARDED_ACTIVITY_POLICY` | `relay` | `relay`: **承認済みリレー**からの代理転送のみ許可。`any`: 誰からの代理転送でも許可（**非推奨**） |
| `SIGNATURE_MAX_AGE_SECONDS` | `43200`（12 時間） | 署名 `Date` ヘッダーの許容幅。リプレイ攻撃対策 |
| `ALLOW_PRIVATE_REMOTE_FETCH` | `PROTOCOL` が `https` なら `false`、それ以外は `true` | プライベート IP・内部ホスト名への remote actor 取得を許可するか（SSRF 対策） |

---

## 3. 管理画面（DB）側の設定

以下は `.env` ではなく管理画面から設定し、DB に保存されます。

- インスタンス情報（表示名・説明・アイコン・バナー）
- 新規登録モード（`open` / `invite` / `closed`）と招待コード
- サーバールール・利用規約 URL・プライバシーポリシー URL・連絡先・運営者・リポジトリ URL
- 連合リレーの登録と承認（`pending` / `accepted` / `rejected`）
- ドメインブロック（拒否するサーバー）
- カスタム絵文字
- Web Push 用 VAPID 鍵（初回起動時に自動生成）
- S3 / R2 認証情報（上記のとおり `.env` より優先）

---

## 4. 環境変数が効かないときのチェック

1. `.env` を編集した後、**サーバーを再起動**しましたか（`.env` は起動時にのみ読み込まれます）。
2. 同じ名前の OS 環境変数が設定されていませんか（`.env` より優先されます）。
3. 正しい `.env` を見ていますか（読み込み順は「1. `.env` の読み込み順」参照）。
4. 実際に解決されている値を確認する:
   ```bash
   cd server
   npx tsx -e "import('./src/config.js').then(m => console.log(m.config))"
   ```

---

## 5. Inbox 署名検証 (HTTP Signature)

Spica は受信した ActivityPub の Activity について、以下を **すべて** 満たす場合のみ受理します。

1. `Signature` ヘッダーが存在し、パースできる
2. 署名対象ヘッダーに `(request-target)` が含まれる（別エンドポイントへの署名の転用を防ぐ）
3. ボディ付きリクエストでは `digest` が署名対象に含まれ、**実際のボディの SHA-256 と一致する**（改ざん防止）
4. 署名の `Date` が `SIGNATURE_MAX_AGE_SECONDS` 以内（リプレイ防止）
5. 署名鍵（`keyId`）の持ち主が **Activity の `actor` と一致**し、その鍵で署名が検証できる

### 代理転送（リレー）の扱い

公開リレーは、他サーバーの Activity を **自分の鍵で** 転送（inbox forwarding）することがあります。この場合 `keyId` の持ち主と `actor` が一致しないため、条件 5 だけでは弾かれてしまいます。

そこで Spica は、**管理画面で `accepted` 済みのリレー**からの転送に限り、この不一致を許容します（`INBOX_FORWARDED_ACTIVITY_POLICY=relay`）。リレー以外の第三者が `actor` を詐称しても拒否されます。

### リバースプロキシと `host` の注意

Cloudflare Tunnel など、`service: http://localhost:3000` のように **Host ヘッダーをローカルオリジンへ書き換える**構成では、受信した `Host` が署名時のドメインと一致しません。Spica はこれに対応するため、`DOMAIN` の値も署名検証の `host` 候補として試行します。

したがって `DOMAIN` が実際の公開ホスト名と異なると、**すべての受信 Activity が署名検証に失敗**します。

### 連合が止まったときの切り分け

サーバーログに以下のような行が出ていないか確認してください。

```
[Inbox Rejected] 🔒 Create from https://example.com/users/alice (keyId: ...) - Signature does not verify against the public key
```

| ログの理由 | 主な原因 |
| --- | --- |
| `Signature header missing` / `Malformed Signature header` | 送信側が署名していない、または自称クライアントによる不正なリクエスト |
| `Digest header does not match the request body` | プロキシによるボディ改変、または改ざん攻撃 |
| `date header is outside the allowed clock skew` | サーバーの時刻ずれ（NTP を確認）、またはリプレイ攻撃 |
| `keyId owner (...) does not match the activity actor (...)` | 未承認のリレー等からの代理転送（`INBOX_FORWARDED_ACTIVITY_POLICY` を確認） |
| `does not verify against the public key` | **`DOMAIN` の設定誤り**（最頻出）、または相手の鍵キャッシュが古い |
| `Remote hostname did not resolve` | 相手サーバーの DNS 障害、または SSRF 対策による拒否 |

一時的に従来の挙動（検証失敗でも受理）に戻したい場合は、`.env` に以下を設定して再起動してください。

```bash
INBOX_SIGNATURE_MODE=log
```

> [!WARNING]
> `log` は署名検証を行わないため、**誰でも任意のユーザーになりすまして投稿を注入できます**。原因を特定したら速やかに `strict` へ戻してください（起動ログに警告が表示されます）。

### 関連するテスト

```bash
npx tsx scripts/test-inbox-signature.ts   # 署名強制の検証（15 項目）
npx tsx scripts/test-federation.ts        # 2 ノード間の署名付き連合
npx tsx scripts/test-relay-and-timelines.ts  # 署名付きリレー受信とタイムライン
```

---

## 8. 追加の環境変数（メディア・動画・メンテナンス・Authorized Fetch・SMTP）

### レート制限・アップロード上限

| 環境変数名 | デフォルト | 説明 |
| :--- | :--- | :--- |
| `RATE_LIMIT_DISABLED` | `false` | `true` でレート制限を無効化（認証 20回/分、API 600回/分、Inbox 3000回/分 / IP単位）。テスト時のみ。 |
| `MEDIA_MAX_BYTES` | `52428800` (50MB) | 動画・音声のアップロード上限（バイト）。画像は別途 15MB まで。 |
| `MEDIA_QUOTA_MB` | `0` (無制限) | ユーザーごとのドライブ容量上限（MB）。超過アップロードは 413 で拒否されます。 |

### 動画サムネイル（任意）

| 環境変数名 | デフォルト | 説明 |
| :--- | :--- | :--- |
| `FFMPEG_PATH` | `ffmpeg` | ffmpeg の実行ファイル（PATH が通っていなければフルパス。`.cmd` ラッパーも可）。 |
| `FFPROBE_PATH` | `ffprobe` | ffprobe の実行ファイル（任意・再生時間と解像度の取得に使用）。 |

ffmpeg は必須ではありません。未インストールの場合は機能だけが無効になり、動画のアップロードは成功します。

### DB メンテナンス

| 環境変数名 | デフォルト | 説明 |
| :--- | :--- | :--- |
| `REMOTE_POST_RETENTION_DAYS` | `30` | リモート投稿の保持日数。`npm run db:maintenance` がこれより古い投稿を削除します（`0` で期間削除なし、`--days` で上書き可）。 |

### Authorized Fetch（署名必須モード・任意）

| 環境変数名 | デフォルト | 説明 |
| :--- | :--- | :--- |
| `AUTHORIZED_FETCH` | `false` | `true` でこちらの取得にも署名を付け、取得側にも署名を必須にします。署名しない相手からは取得できなくなり互換性が下がります。 |

### 画像プロキシ（リモート画像の直リンク解消）

| 変数 | 既定 | 説明 |
| :--- | :--- | :--- |
| `IMAGE_PROXY` | `true` | リモート画像をこのノード経由で配信します。無効にすると相手サーバーから直接読み込みます（閲覧者の IP が相手に渡ります）。 |
| `IMAGE_PROXY_MAX_MB` | `512` | キャッシュの上限（MB）。超えると最終使用が古いものから削除します。 |
| `IMAGE_PROXY_TTL_DAYS` | `30` | キャッシュの保持日数。 |

管理画面（ダッシュボード →「容量とメンテナンス」）から有効/無効と上限を変更でき、「キャッシュを整理」で即時削除もできます。取得は SSRF ガード・8MB 上限・8秒タイムアウトつきで、画像以外のコンテンツは配信しません。キャッシュは `server/data/proxy-cache/` に置かれ、毎日の自動整理と `npm run db:maintenance -- --apply`（⑥）で期限切れ分が削除されます。

### メール通知（SMTP 設定時のみ）

| 変数 | 既定 | 説明 |
| :--- | :--- | :--- |
| `EMAIL_NOTIFICATIONS` | `true` | メール通知機能を有効にします（SMTP 未設定なら機能ごと無効）。 |
| `EMAIL_BATCH_SECONDS` | `60` | この秒数だけ待って、たまった通知を 1 通にまとめます。`0` で即時。 |
| `EMAIL_THROTTLE_MINUTES` | `5` | 同じユーザーへメールを送る最短間隔。 |

受け取るかどうかは**ユーザーごとのオプトイン**（既定 OFF）で、設定 → 投稿・表示設定 →「メールでも通知を受け取る」から切り替えます。宛先は確認済みのメールアドレスのみ。種類別の通知設定で切った種類はメールも飛びません。

### メール送信（SMTP・任意）

| 環境変数名 | デフォルト | 説明 |
| :--- | :--- | :--- |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_SECURE` | (未設定) / `587` / `false` | SMTP サーバー。通常は管理画面「メール・認証」から設定します（こちらが優先）。 |
| `SMTP_USER` / `SMTP_PASS` / `SMTP_FROM` | (未設定) | SMTP 認証情報と送信元アドレス。 |

**メール関連は SMTP が設定されているときだけ有効**です（マスターキー復元、パスワード方式の登録時の確認コード、メールアドレスの確認）。未設定なら確認コードは要求されず、従来どおり登録できます。

---

---

## 8-2. ドメインブロックとサイレンス

管理画面 →「ブロック」から、ドメインごとに 2 段階で制限できます。

| 強度 | 通信（Inbox/Delivery） | 表示（ホーム・ローカル・検索・通知） | データ |
| :--- | :--- | :--- | :--- |
| 🚫 ブロック（suspend・既定） | 403 で遮断（WebFinger も停止） | 非表示 | キャッシュ済み投稿・アクター情報を削除 |
| 🔇 サイレンス（silence） | 維持（配送・フォローはそのまま） | 非表示 | **削除しない**（後から戻せる） |

サイレンスは「様子見したいが、タイムラインには出したくない」ときに使います。`blocked_domains.severity` に保存されます。

## 8-3. 権限・監査ログ（複数人で運営する）

### 権限

| 権限 | できること |
| :--- | :--- |
| `admin` | 管理パネルのすべての操作（`users.role = 'admin'` または `admin` 権限のロール） |
| `moderate` | 通報の対応・ユーザーの凍結/解除・ドメインブロックのみ（管理パネルには通報とブロックのタブだけが出ます） |

実際に判定している権限はこの 2 つです（`server/src/auth.ts` の `hasPermission`）。画面の出し分けは `/api/auth/me` が返す `permissions` 配列で行います。

### 監査ログ

管理 API（`/api/admin/*`）への変更操作（POST / PUT / PATCH / DELETE）が成功したときだけ `admin_actions` に記録します。「誰が（`actor_id`）・いつ（`created_at`）・何を（`action` / 表示ラベル）・どの対象に（`target_type` / `target_id`）・どんな内容で（`detail`）」が残り、管理画面の「監査ログ」タブから操作の種類で絞り込み・ページングして読めます。

- パスワード・トークン・鍵などを含むキーは記録時に `***` へ伏せます。
- 拒否された操作（403）は記録しません。参照（GET）も記録しません。
- 記録失敗で本来の操作を止めません（ログのみ）。
- 保持期間は設けていません。肥大化したら管理画面の「古いログを削除」で 180 日より前のものを削除できます。

## 9. 検索索引とリモートコンテンツの保存（DB 肥大化対策）

リレー経由のリモート投稿は DB を急速に膨らませます（実測でリモート投稿の索引が約4割、フォロー外のブーストが約1/4）。Mastodon / Misskey と同じく、**既定ではリモート投稿の本文を索引せず、フォロー外のブーストも保存しません**。

| 環境変数名 | デフォルト | 説明 |
| :--- | :--- | :--- |
| `FTS_INDEX_SCOPE` | `local` | 検索索引の範囲。`local`（ローカル投稿のみ・推奨）/ `follows`（＋フォロー中アクターと自分宛の返信）/ `all`（すべて・旧来の挙動）。 |
| `REMOTE_ANNOUNCE_POLICY` | `follows` | リモートのブーストを保存する範囲。`follows`（フォロー中のみ・推奨）/ `all` / `none`。 |

管理画面 → サーバー設定 →「検索とリモート投稿の保存」からも変更できます（DB 保存・env より優先）。既存データへ遡って適用するには、サーバーを停止して `npm run db:maintenance -- --apply` を実行してください。

---

---

## 10. 運用の自動化（毎日 1 回の整理とバックアップ）

毎日の整理では「バックアップ → 保存方針の適用 → 保持期間を超えたリモート投稿の削除 → 画像プロキシのキャッシュ整理」を行います。VACUUM（領域の解放）だけは手動で、サーバーを停止してから `npm run db:maintenance -- --apply` を実行してください。

| 環境変数名 | デフォルト | 説明 |
| :--- | :--- | :--- |
| `AUTO_MAINTENANCE` | `true` | 毎日 1 回の自動整理（バックアップ → 方針適用 → 保持期間を超えたリモート投稿の削除）。 |
| `AUTO_MAINTENANCE_HOUR` | `4` | 実行時刻（0〜23）。 |
| `AUTO_BACKUP` | `true` | 整理の前に `VACUUM INTO` でバックアップを取るか。 |
| `BACKUPS_KEEP` | `3` | バックアップの保持世代数。 |

VACUUM（領域の解放）は排他ロックが必要なため自動では行いません（`npm run db:maintenance -- --apply` をサーバー停止時に）。管理画面のダッシュボードから ON/OFF・時刻変更・即時実行ができます。バックアップのみは `--backup-only`。外形監視は `GET /health`（認証付きで詳細）。SIGTERM/SIGINT で WAL をチェックポイントして終了します（POSIX のみ）。

---

