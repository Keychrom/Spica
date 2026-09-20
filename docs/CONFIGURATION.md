# ⚙️ Spica 環境設定リファレンス (CONFIGURATION.md)

本ドキュメントでは、Spica の動作を制御する環境設定ファイル（`.env`）および管理画面設定の各パラメータについて解説します。

---

## 📁 設定ファイルの位置

Spica は起動時に以下の優先順序で `.env` ファイルを探索し、自動的にロードします：
1. アプリケーションルートディレクトリの `.env`
2. `server/` ディレクトリ直下の `.env`

未指定の項目については、安全な初期値（デフォルト値）が自動的に適用されます。

---

## 🌐 1. サーバー・ネットワーク設定

| 環境変数名 | 型 | デフォルト値 | 必須 | 説明 |
| :--- | :--- | :--- | :--- | :--- |
| `PORT` | 数値 | `3000` | 任意 | バックエンド Node.js サーバーがリッスンする TCP ポート番号。 |
| `BIND_HOST` | 文字列 | `0.0.0.0` | 任意 | バインドする IP アドレス。`127.0.0.1` を指定するとローカルホストからのみ接続可能になります（Nginx プロキシ配下での推奨）。 |
| `DOMAIN` | 文字列 | `localhost:3000` | **推奨** | 外部公開するサーバーの FQDN（例: `spica.example.com`）。ActivityPub の Actor ID や WebFinger アドレスに使用されます。 |
| `PROTOCOL` | 文字列 | `https` (ローカル時は `http`) | 任意 | 公開プロトコル（`https` または `http`）。インターネット公開時は必ず `https` を使用してください。 |

> [!NOTE]
> `DOMAIN` にプロトコル（`https://`）や末尾スラッシュは含めないでください。自動的に整形されます。

> [!IMPORTANT]
> `DOMAIN` は HTTP Signature の検証でも「署名された host」の候補として使用されます。実際の公開ホスト名と一致していない場合、他サーバーからの配送がすべて署名検証に失敗し、連合が停止します（詳細は「[6. Inbox 署名検証](#-6-inbox-署名検証-http-signature)」）。

---

## 🗄️ 2. データベース設定

| 環境変数名 | 型 | デフォルト値 | 必須 | 説明 |
| :--- | :--- | :--- | :--- | :--- |
| `DB_PATH` | 文字列 | `data_astrabit.sqlite` | 任意 | SQLite データベースファイルの保存パス（相対パスまたは絶対パス）。定期バックアップの対象です。 |

---

## 🏷️ 3. インスタンス基本情報

| 環境変数名 | 型 | デフォルト値 | 必須 | 説明 |
| :--- | :--- | :--- | :--- | :--- |
| `INSTANCE_NAME` | 文字列 | `Spica` | 任意 | ノードの表示名。NodeInfo やウェルカム画面等で表示されます。 |
| `INSTANCE_DESCRIPTION` | 文字列 | (説明文) | 任意 | ノードの概要・紹介文。 |

---

## ☁️ 4. メディアオブジェクトストレージ設定 (S3 / Cloudflare R2)

投稿に添付される画像や動画を外部オブジェクトストレージへ直接保管・配信するための設定です。  
※未設定の場合は、サーバー内の `data/uploads` ディレクトリへローカル保存されます。

| 環境変数名 | 型 | サンプル値 | 説明 |
| :--- | :--- | :--- | :--- |
| `S3_ENDPOINT` | 文字列 | `https://<account>.r2.cloudflarestorage.com` | S3 互換ストレージのエンドポイント URL。 |
| `S3_BUCKET` | 文字列 | `spica-media` | 保存先バケットの名前。 |
| `S3_REGION` | 文字列 | `auto` (AWSなら `ap-northeast-1`) | リージョン識別子。 |
| `S3_ACCESS_KEY_ID` | 文字列 | `(英数字トークン)` | API アクセスキー ID。 |
| `S3_SECRET_ACCESS_KEY` | 文字列 | `(秘密キー)` | API シークレットアクセスキー。 |
| `S3_PUBLIC_URL` | 文字列 | `https://media.example.com` | アップロードされたメディアの公開配信 URL。 |

> [!TIP]
> ストレージ設定は、Web 上の **管理パネル（⚙️ 管理パネル > ストレージ設定）** からも設定・変更および接続テストが可能です。

---

## 🔔 5. Web Push 通知設定 (VAPID)

PWA やモバイルブラウザへのプッシュ通知に使用されるキーペアです。

| 環境変数名 | 型 | 説明 |
| :--- | :--- | :--- |
| `VAPID_PUBLIC_KEY` | 文字列 | VAPID 公開鍵。未設定の場合、サーバー初回起動時に自動生成されます。 |
| `VAPID_PRIVATE_KEY`| 文字列 | VAPID 秘密鍵。未設定の場合、サーバー初回起動時に自動生成されます。 |
| `VAPID_SUBJECT` | 文字列 | プッシュサービス提供者への連絡先（例: `mailto:admin@example.com`）。 |

---

## 🔐 6. Inbox 署名検証 (HTTP Signature)

受信した ActivityPub の Activity が「本当にその `actor` 本人から送られたものか」を検証する設定です。  
既定では、検証に失敗した Activity は **401 で拒否** され、なりすまし投稿・改ざん・リプレイ攻撃を防ぎます。

| 環境変数名 | 型 | デフォルト値 | 必須 | 説明 |
| :--- | :--- | :--- | :--- | :--- |
| `INBOX_SIGNATURE_MODE` | 文字列 | `strict` | 任意 | `strict`: 検証失敗を 401 で拒否（**推奨**）。`log`: 警告ログのみで処理を続行（従来挙動・**非推奨**）。 |
| `INBOX_FORWARDED_ACTIVITY_POLICY` | 文字列 | `relay` | 任意 | `relay`: 管理パネルで承認済み（`accepted`）のリレーからの代理転送のみ許可。`any`: 誰からの代理転送でも許可（**非推奨**）。 |
| `SIGNATURE_MAX_AGE_SECONDS` | 数値 | `43200`（12 時間） | 任意 | 署名 `Date` ヘッダーの許容幅（秒）。リプレイ攻撃対策です。 |
| `ALLOW_PRIVATE_REMOTE_FETCH` | 真偽値 | `https` 公開時は `false` | 任意 | プライベート IP・内部ホスト名への remote actor 取得を許可するか（SSRF 対策）。同一 LAN 内の自前ノードと連合テストする場合のみ `true`。 |

### 検証項目

1. `Signature` ヘッダーが存在し、パースできること
2. 署名対象ヘッダーに `(request-target)` が含まれること（署名の別エンドポイントへの転用防止）
3. ボディ付きリクエストでは `digest` が署名対象に含まれ、**実際のボディの SHA-256 と一致**すること（改ざん防止）
4. 署名の `Date` が `SIGNATURE_MAX_AGE_SECONDS` 以内であること（リプレイ防止）
5. 署名鍵（`keyId`）の持ち主が Activity の `actor` と一致し、その鍵で署名が検証できること（なりすまし防止）

### リレーによる代理転送について

公開リレーは、他サーバーの Activity を **自分の鍵で** 転送（inbox forwarding）することがあります。この場合 5 の条件を満たさないため、Spica は **管理パネルで `accepted` 済みのリレー** からの転送に限ってこれを許容します（`INBOX_FORWARDED_ACTIVITY_POLICY=relay`）。承認していない第三者が `actor` を詐称しても拒否されます。

### リバースプロキシ経由時の `DOMAIN` の重要性

Cloudflare Tunnel など Host ヘッダーをローカルオリジンへ書き換える構成では、受信した `Host` が署名時のドメインと一致しません。Spica はこれに対応するため `DOMAIN` の値を署名検証の `host` 候補として試行します。  
したがって **`DOMAIN` が実際の公開ホスト名と一致していないと、すべての受信 Activity が署名検証に失敗します。**

### 連合が停止した場合の切り分け

サーバーログの `[Inbox Rejected]` 行に拒否理由が記録されます。

| ログ中の理由 | 主な原因 |
| :--- | :--- |
| `Signature header missing` / `Malformed Signature header` | 送信側が署名していない、または不正なリクエスト |
| `Digest header does not match the request body` | プロキシによるボディ改変、または改ざん攻撃 |
| `date header is outside the allowed clock skew` | サーバーの時刻ずれ（NTP を確認）、またはリプレイ攻撃 |
| `keyId owner (...) does not match the activity actor (...)` | 未承認のリレー等からの代理転送 |
| `does not verify against the public key` | **`DOMAIN` の設定誤り（最頻出）** |
| `Remote hostname did not resolve` | 相手サーバーの DNS 障害、または SSRF 対策による拒否 |

> [!WARNING]
> `INBOX_SIGNATURE_MODE=log` は署名を検証しないため、**誰でも任意のユーザーになりすまして投稿を注入できます**。原因を特定したら速やかに `strict` へ戻してください。`log` で起動した場合は起動ログに警告が表示されます。

### 関連するテストスクリプト

```bash
npx tsx scripts/test-inbox-signature.ts          # 署名強制の検証（15 項目）
npx tsx scripts/test-federation.ts               # 2 ノード間の署名付き連合
npx tsx scripts/test-relay-and-timelines.ts      # 署名付きリレー受信とタイムライン
```

> [!NOTE]
> テストスクリプトは既定でポート 3000 を使用します。サーバーが稼働中の環境では `TEST_PORT` で空きポートを指定してください。指定せずに実行すると、稼働中のサーバーが応答している場合に処理を中断します（誤って本番データを書き換えないための保護です）。

---

## 🛠️ 管理パネルから変更できる動的設定

以下の項目は、環境変数ではなく **管理パネル（Web UI）** からいつでもリアルタイムに変更・保存できます：

- **サーバールール**: 箇条書きルールの追加・編集・並び替え
- **新規登録時のルール同意必須化**: ON / OFF の切り替え
- **ポリシー URL**: 利用規約、プライバシーポリシー、お問い合わせ先、リポジトリ URL
- **連合リレー**: YUKARI リレー等の ActivityPub 連合リレー追加・削除
- **カスタム絵文字**: サーバー独自絵文字の登録・画像アップロード
- **ドメインブロック / IP ブロック**: 悪質サーバーやスパムのアクセス遮断
