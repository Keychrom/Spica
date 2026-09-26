#!/usr/bin/env bash
# スイートを順に回して合否だけを並べる（開発時の確認用・配布物ではない）
#   使い方: bash scripts/run-suites.sh [suite 名の一部...]
# 引数が無いときは既定の一覧を回す。DB_DRIVER / DATABASE_URL はそのまま使う。
set -u
cd "$(dirname "$0")/.." || exit 1

DEFAULT_SUITES=(
  inbox-signature relay-and-timelines federation pagination followers-visibility reports
  filters-and-locked announcements differentiation import lists media-video
  search-operators discovery roles profile-fields mail-recovery password-auth
  dm-policy drive notification-prefs video-thumbnail search-policy ops-automation
  secret-scan silence-featured image-proxy email-notify admin-audit metrics backup-restore
  antennas-and-scheduler account-deletion export-and-rules fts-push
  theme-channels-webauthn db-maintenance pg-translate db-async redis stream-scope job-queue multiprocess
)

SUITES=("$@")
if [ ${#SUITES[@]} -eq 0 ]; then SUITES=("${DEFAULT_SUITES[@]}"); fi

# Redis の検査は接続先があれば実物でも回す（環境変数 → .env の順。無くても in-memory の検査は通る）
TEST_REDIS_URL="${TEST_REDIS_URL:-}"
if [ -z "$TEST_REDIS_URL" ] && [ -f .env ]; then
  TEST_REDIS_URL="$(sed -e 's/^\xEF\xBB\xBF//' -e 's/\r$//' .env | grep -E '^TEST_REDIS_URL=' | head -1 | cut -d= -f2-)"
fi
export TEST_REDIS_URL

LOG_DIR="${LOG_DIR:-/tmp/spica-suites}"
mkdir -p "$LOG_DIR"
pass=0; fail=0; failed_names=()

for s in "${SUITES[@]}"; do
  log="$LOG_DIR/$s.log"
  printf '\n=== %s ===\n' "$s"
  # npm のエイリアスが無いスイートもあるので、ファイルを直接叩く
  case "$s" in
    federation) suite_env='TEST_PORT=3400' ;;   # 稼働中の開発サーバー（:3000）と衝突させない
    *) suite_env='' ;;
  esac
  timeout "${SUITE_TIMEOUT:-300}" env $suite_env npx tsx "scripts/test-$s.ts" > "$log" 2>&1
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
