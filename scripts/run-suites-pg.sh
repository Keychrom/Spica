#!/usr/bin/env bash
# PostgreSQL でもスイートを回す（各スイートの前にテスト DB を作り直す）
#
#   bash scripts/run-suites-pg.sh [suite 名の一部...]
#
# 前提: .env の TEST_DATABASE_URL が PostgreSQL のテスト用 DB を指していること。
# SQLite 側の全スイートを PG で回せるわけではない（docs/POSTGRESQL.md の表を参照）。
set -u
cd "$(dirname "$0")/.." || exit 1

# テスト用 DSN は環境変数 → .env の順に読む（CI には .env が無い）
DSN="${TEST_DATABASE_URL:-}"
if [ -z "$DSN" ] && [ -f .env ]; then
  DSN="$(sed -e 's/^\xEF\xBB\xBF//' -e 's/\r$//' .env | grep -E '^TEST_DATABASE_URL=' | head -1 | cut -d= -f2-)"
fi
if [ -z "$DSN" ]; then
  echo "❌ TEST_DATABASE_URL がありません（環境変数か .env に設定してください）" >&2
  exit 2
fi

export DB_DRIVER=postgres
export DATABASE_URL="$DSN"
export TEST_DATABASE_URL="$DSN"

# Redis の検査も回す（接続先は環境変数 → .env の順。無ければ in-memory の検査だけになる）
TEST_REDIS_URL="${TEST_REDIS_URL:-}"
if [ -z "$TEST_REDIS_URL" ] && [ -f .env ]; then
  TEST_REDIS_URL="$(sed -e 's/^\xEF\xBB\xBF//' -e 's/\r$//' .env | grep -E '^TEST_REDIS_URL=' | head -1 | cut -d= -f2-)"
fi
export TEST_REDIS_URL

# PG でも通るスイート（docs/POSTGRESQL.md の「テストスイートを PG で回す場合」を参照）
DEFAULT_SUITES=(
  pg-port pg-backup pg-translate db-async admin-audit email-notify image-proxy ops-automation
  reports silence-featured pagination announcements antennas-and-scheduler
  account-deletion fts-push export-and-rules theme-channels-webauthn
  password-auth federation search-policy redis stream-scope job-queue
)

SUITES=("$@")
if [ ${#SUITES[@]} -eq 0 ]; then SUITES=("${DEFAULT_SUITES[@]}"); fi

LOG_DIR="${LOG_DIR:-/tmp/spica-suites-pg}"
mkdir -p "$LOG_DIR"
pass=0; fail=0; failed_names=()

for s in "${SUITES[@]}"; do
  log="$LOG_DIR/$s.log"
  printf '\n=== %s ===\n' "$s"

  # pg-port は「SQLite を作って PG へ移送する」検査なので、DB_DRIVER を PG にしてはいけない
  # （PG 側は TEST_DATABASE_URL で直接繋ぐ）
  unset_list=""
  if [ "$s" = "pg-port" ]; then
    unset_list="-u DB_DRIVER -u DATABASE_URL"
  fi
  # federation は 2 ノードを立てる。稼働中の開発サーバー（:3000）と衝突しないよう別ポートを使う
  if [ "$s" = "federation" ]; then
    export TEST_PORT=3400
  else
    unset TEST_PORT
  fi

  npx tsx scripts/pg-init.ts --dsn "$DSN" --reset > "$log" 2>&1
  init_code=$?
  if [ $init_code -ne 0 ]; then
    echo "  DB の作り直しに失敗（スキップ）"
    tail -3 "$log"
    fail=$((fail + 1)); failed_names+=("$s (pg-init exit $init_code)")
    continue
  fi
  # shellcheck disable=SC2086
  timeout "${SUITE_TIMEOUT:-300}" env $unset_list npx tsx "scripts/test-$s.ts" >> "$log" 2>&1
  code=$?
  tail -4 "$log"
  if [ $code -eq 0 ]; then
    pass=$((pass + 1))
  else
    fail=$((fail + 1)); failed_names+=("$s (exit $code)")
  fi
done

printf '\n=========================================\n'
printf '  成功 %d / 失敗 %d\n' "$pass" "$fail"
if [ $fail -gt 0 ]; then
  printf '  失敗したスイート:\n'
  for n in "${failed_names[@]}"; do printf '   - %s\n' "$n"; done
fi
printf '  ログ: %s\n' "$LOG_DIR"
