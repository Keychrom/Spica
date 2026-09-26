#!/usr/bin/env bash
# git を使わずにコピーで配置した Spica を最新へ更新する
#
#   bash scripts/update-by-copy.sh                 # このスクリプトのあるツリーを更新
#   bash scripts/update-by-copy.sh --dir /opt/spica
#   bash scripts/update-by-copy.sh --ref v1.2.0    # タグやブランチを指定
#   bash scripts/update-by-copy.sh --yes           # 確認を挟まない
#   bash scripts/update-by-copy.sh --verify-url http://localhost:3100
#
# やること:
#   1. 配置先の確認（Spica のインストールか、更新に必要なコマンドがあるか）
#   2. .env の控えと DB のバックアップ（`npm run db:maintenance --apply` = WAL を含む 1 ファイル）
#   3. GitHub のアーカイブを重ねる（.env・DB・uploads・node_modules はアーカイブに含まれない）
#   4. npm install / npm run build
#   5. 再起動と確認のコマンドを表示（**再起動は自動でやりません**: pm2 / systemd は環境依存）
#
# 注意: このスクリプトは「配置先のホストで」実行してください。SSH 越しの更新はしません。
set -u

REPO_URL="${SPICA_REPO_URL:-https://github.com/Keychrom/Spica}"
REF="main"
DIR=""
ASSUME_YES=false
VERIFY_URL=""

usage() {
  sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
}

while [ $# -gt 0 ]; do
  case "$1" in
    --dir) DIR="${2:-}"; shift 2 ;;
    --ref) REF="${2:-}"; shift 2 ;;
    --yes|-y) ASSUME_YES=true; shift ;;
    --verify-url) VERIFY_URL="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "❌ 不明な引数: $1" >&2; usage >&2; exit 64 ;;
  esac
done

if [ -z "$DIR" ]; then
  DIR="$(cd "$(dirname "$0")/.." && pwd)"
fi
if [ ! -d "$DIR" ]; then
  echo "❌ 配置先がありません: $DIR" >&2
  exit 66
fi
cd "$DIR" || exit 66

if [ ! -f package.json ] || [ ! -d server/src ]; then
  echo "❌ Spica のインストールに見えません: $DIR" >&2
  echo "   （package.json と server/src があるディレクトリを --dir で指定してください）" >&2
  exit 66
fi

for cmd in curl tar npm; do
  if ! command -v "$cmd" > /dev/null 2>&1; then
    echo "❌ $cmd が見つかりません。先にインストールしてください。" >&2
    exit 69
  fi
done

echo "=========================================="
echo " Spica を更新します（コピー配置）"
echo "   配置先: $DIR"
echo "   取得元: $REPO_URL ($REF)"
echo "=========================================="
echo ""

if [ "$ASSUME_YES" != true ]; then
  printf "続けますか？ [y/N] "
  read -r answer
  case "$answer" in
    y|Y|yes|YES) ;;
    *) echo "中止しました。"; exit 0 ;;
  esac
fi

# ---------------------------------------------------------------------------
# 1. バックアップ（DB は WAL の内容も含めた 1 ファイルを書き出す）
# ---------------------------------------------------------------------------
echo ""
echo "■ 1/4 バックアップ"
if [ -f .env ]; then
  cp .env ".env.bak_$(date +%Y%m%d_%H%M%S)"
  echo "  .env を控えました"
fi
if [ -d node_modules ] && [ -f server/package.json ]; then
  if npm run db:maintenance -- --apply 2>&1 | tail -6; then
    echo "  DB のバックアップを取りました（server/data/backups/）"
  else
    echo "  ⚠️  DB のバックアップに失敗しました。手順書（docs/UPGRADE.md）の"
    echo "      「方法 B: 3 点セットでコピー」で先にバックアップしてから、もう一度実行してください。"
    exit 70
  fi
else
  echo "  ⚠️  node_modules が無いので DB のバックアップを飛ばしました。"
  echo "      初回は手順書（docs/UPGRADE.md）の方法 B でバックアップしてください。"
fi

# ---------------------------------------------------------------------------
# 2. アーカイブの取得と検証（404 の HTML を展開しないよう、先に中身を確かめる）
# ---------------------------------------------------------------------------
echo ""
echo "■ 2/4 最新のアーカイブを取得"
ARCHIVE="$(mktemp -t spica-update-XXXXXX.tar.gz)"
trap 'rm -f "$ARCHIVE"' EXIT

URL="$REPO_URL/archive/refs/heads/$REF.tar.gz"
if ! curl -fsSL -o "$ARCHIVE" "$URL"; then
  # タグのときは refs/tags 側を試す
  URL="$REPO_URL/archive/refs/tags/$REF.tar.gz"
  if ! curl -fsSL -o "$ARCHIVE" "$URL"; then
    echo "❌ 取得に失敗しました: $URL" >&2
    exit 68
  fi
fi
echo "  取得: $URL ($(wc -c < "$ARCHIVE" | tr -d ' ') bytes)"

if ! tar tzf "$ARCHIVE" | grep -q '/server/src/index.ts$'; then
  echo "❌ アーカイブの中身が Spica ではありません（展開を中止しました）" >&2
  exit 65
fi

# ---------------------------------------------------------------------------
# 3. 重ねる（アーカイブに .env・DB・uploads は含まれないので、それらは無傷）
# ---------------------------------------------------------------------------
echo ""
echo "■ 3/4 ファイルを重ねる"
if ! tar xzf "$ARCHIVE" --strip-components=1; then
  echo "❌ 展開に失敗しました。" >&2
  exit 65
fi
echo "  完了（.env / DB / uploads / node_modules は上書きしていません）"

# ---------------------------------------------------------------------------
# 4. 依存とビルド
# ---------------------------------------------------------------------------
echo ""
echo "■ 4/4 依存の更新とビルド"
if ! npm install; then
  echo "❌ npm install に失敗しました。" >&2
  exit 70
fi
if ! npm run build; then
  echo "❌ npm run build に失敗しました。" >&2
  exit 70
fi

# ---------------------------------------------------------------------------
# 再起動と確認
# ---------------------------------------------------------------------------
cat <<'EOS'

✅ ファイルの更新とビルドが終わりました。**再起動すると新しいコードが有効になります。**

  PM2 の場合:      pm2 reload spica      （logs で起動を確認: pm2 logs spica --lines 30）
  systemd の場合:  sudo systemctl restart spica

再起動したら、新しいコードが動いているかを確認できます（ログイン不要）:

  curl -si http://localhost:<ポート>/robots.txt | head -3
      → Content-Type: text/plain なら新しいコード
      → text/html なら古いプロセスが残っています（再起動を確認してください）

  curl -si http://localhost:<ポート>/sitemap.xml | head -3     → application/xml
  curl -si http://localhost:<ポート>/metrics    | head -3     → 404（JSON）または 401
EOS

if [ -n "$VERIFY_URL" ]; then
  echo ""
  echo "■ 確認 ($VERIFY_URL)"
  for path in /robots.txt /sitemap.xml /metrics; do
    printf "  %-16s %s\n" "$path" "$(curl -s -o /dev/null -m 10 -w '%{http_code} %{content_type}' "$VERIFY_URL$path" 2>/dev/null || echo '取得できません')"
  done
  echo "  → robots.txt が text/plain なら更新できています。"
fi
