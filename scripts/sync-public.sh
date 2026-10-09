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
  # ライセンス（2026-10-03 に MIT から AGPL-3.0-or-later へ。両ツリーで同じ本文にする）
  LICENSE
  # client/ は src だけを運んでいたため、index.html の変更（メタ情報・フィード案内）が
  # 公開ツリーへ入らない事故になりかけた。単体のファイルはここに明示する
  client/index.html
  # 2026-10-10 にフロントエンドを一から書き直した（案K 雅＋）。ビルドの設定と説明も運ぶ
  client/vite.config.ts
  client/tsconfig.json
  client/README.md
  docs/CONFIGURATION.md
  docs/FEATURES.md
  # 2段階認証（TOTP）の説明。FEATURES.md からリンクしているので公開ツリーにも運ぶ
  docs/SECURITY-2FA.md
  docs/POSTGRESQL.md
  docs/REDIS.md
  docs/SCALE.md
  # Fediverse ソフトの比較（公開してよい読み物）
  docs/FEDIVERSE-COMPARISON.md
  # 設計（プロセスと状態の置き場所）。PROCESS_ROLE の説明はここが正
  docs/ARCHITECTURE.md
  # セットアップ手順は 2026-09-25 に両ツリーで同一にした（公開側だけ古い記述が残って
  # 「配送は並列になりません」などと書かれていた）。以後は丸ごとコピーで揃える
  docs/SETUP_Normal.md
  docs/SETUP_PostgreSQL_Redis.md
  package.json
  # 依存は server ワークスペース側にある（redis のように追加したものが公開ツリーへ入らないと
  # `npm ci` が失敗する）。ロックも一緒に運んで、両方のツリーで同じ依存にする
  package-lock.json
  server/package.json
  # client ワークスペースの依存（lucide-react など）もここ。運び忘れると .17 のビルドが失敗する
  client/package.json
)
DIRS=(
  .github/workflows
  client/src
  # manifest / アイコン / sw.js など（2026-10-04 追加: manifest.json の share_target が運ばれなかった）
  client/public
  # 大きさの検査（npm run check:size）で使う。フロントエンドの README から参照している
  client/scripts
  # フロントエンドのデザイン（案K 雅＋）。client/README.md と design/README.md が相互に参照する
  design
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
      # ★ 拡張子を増やすときは注意: ここに無い種類（かつては .css）は**黙って運ばれない**。
      #   2026-10-04 に .css を追加（文字サイズ・密度の見た目が公開ツリーへ入らなかった）
      #   2026-10-10 に .html / .md を追加（design/ のモックアップと説明が運ばれなかった）
      *.ts|*.tsx|*.js|*.mjs|*.sh|*.sql|*.json|*.yml|*.yaml|*.css|*.html|*.md) copy_file "$rel" ;;
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
