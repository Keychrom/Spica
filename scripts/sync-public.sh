#!/usr/bin/env bash
# 開発ツリー（SN-SNS）から公開ツリー（D:/Spica）へソースだけを同期する。
#
#   bash scripts/sync-public.sh            # 何が変わるか表示（コピーしない）
#   bash scripts/sync-public.sh --apply    # 実際にコピー
#
# 方針:
#   - コピーするのはソースとドキュメントだけ。.env / *.sqlite / uploads / dist / node_modules は触らない。
#   - 公開ツリーだけにある手書きの差分（README の Alpha 警告、SETUP.md / UPGRADE.md の本番向け記述）は
#     上書きしない。対象ファイルを明示して、必要なものだけを運ぶ。
#   - 運んだあとは `npm run check:secrets` で秘密の混入を確認する。
set -eu
DEV_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PUB_DIR="${PUB_DIR:-/d/Spica}"
APPLY=false
[ "${1:-}" = "--apply" ] && APPLY=true

if [ ! -d "$PUB_DIR/.git" ]; then
  echo "❌ 公開ツリーが見つかりません: $PUB_DIR" >&2
  exit 2
fi

# 運ぶ対象（公開ツリーと共有しているファイルだけ）
# ※ README.md は公開ツリー側にだけ Alpha 警告の一文があるので、丸ごとコピーしない。
#    差分が数行なら手で当てる（下の「手で当てるファイル」を参照）。
FILES=(
  .env.example
  docs/CONFIGURATION.md
  docs/FEATURES.md
  docs/POSTGRESQL.md
  docs/REDIS.md
  docs/SCALE.md
  # セットアップ手順は 2026-09-25 に両ツリーで同一にした（公開側だけ古い記述が残って
  # 「配送は並列になりません」などと書かれていた）。以後は丸ごとコピーで揃える
  docs/SETUP_Normal.md
  docs/SETUP_PostgreSQL_Redis.md
  package.json
  # 依存は server ワークスペース側にある（redis のように追加したものが公開ツリーへ入らないと
  # `npm ci` が失敗する）。ロックも一緒に運んで、両方のツリーで同じ依存にする
  package-lock.json
  server/package.json
)
DIRS=(
  .github/workflows
  client/src
  server/src
  scripts
)

copy_file() {
  local rel="$1"
  if [ ! -f "$DEV_DIR/$rel" ]; then
    echo "  ⚠️  開発ツリーにありません: $rel"
    return
  fi
  if cmp -s "$DEV_DIR/$rel" "$PUB_DIR/$rel"; then return; fi
  echo "  → $rel"
  if $APPLY; then
    mkdir -p "$(dirname "$PUB_DIR/$rel")"
    cp "$DEV_DIR/$rel" "$PUB_DIR/$rel"
  fi
}

echo "=========================================="
echo " 公開ツリーへ同期: $DEV_DIR → $PUB_DIR"
echo "=========================================="
if ! $APPLY; then echo "（--apply を付けると実際にコピーします）"; fi

echo ""
echo "■ ドキュメント"
for f in "${FILES[@]}"; do copy_file "$f"; done

echo ""
echo "■ ソース"
for dir in "${DIRS[@]}"; do
  # 公開ツリーに無いファイル（新規）と、内容が違うファイルを運ぶ
  while IFS= read -r rel; do
    case "$rel" in
      *.ts|*.tsx|*.js|*.mjs|*.sh|*.sql|*.json|*.yml|*.yaml) copy_file "$rel" ;;
    esac
  done < <(cd "$DEV_DIR" && find "$dir" -type f \
    -not -path "*/node_modules/*" -not -path "*/dist/*" \
    -not -name "*.sqlite*" -not -name ".env" -print | sed 's#\\#/#g')
done

echo ""
echo "■ 手で当てるファイル（丸ごとコピーしない）"
echo "  README.md … 公開ツリーの Alpha 警告を残したまま、差分だけを手で当てる"
echo "  docs/SETUP.md … 公開ツリー側が本番向けの別版"
echo "  docs/UPGRADE.md / docs/ABOUT_SPICA.md … 同上"

echo ""
echo "■ 公開ツリーにしかないファイル（削除の確認）"
for stale in server/src/db/pgWorker.ts; do
  if [ -f "$PUB_DIR/$stale" ] && [ ! -f "$DEV_DIR/$stale" ]; then
    echo "  ✂️  削除: $stale"
    if $APPLY; then rm -f "$PUB_DIR/$stale"; fi
  fi
done

echo ""
if $APPLY; then
  echo "✅ 同期しました。次を実行して確認してください:"
  echo "   cd $PUB_DIR && npm run check:secrets && git status --short"
else
  echo "ℹ️  表示のみ（コピーしていません）"
fi
