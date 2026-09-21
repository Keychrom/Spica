#!/usr/bin/env node
/**
 * git フック（秘密情報のコミット前スキャン）を有効にする。
 *
 * npm install 時に `prepare` から自動実行されます。
 * git リポジトリでないツリー（開発ツリー）では何もしません。
 *
 * 手動実行: npm run hooks:install
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOOKS_DIR = '.githooks';
const HOOK_NAME = 'pre-commit';

function main() {
  if (!fs.existsSync(path.join(ROOT_DIR, '.git'))) {
    // 開発ツリー（git 管理外）では何もしない
    process.exit(0);
  }

  const hookFile = path.join(ROOT_DIR, HOOKS_DIR, HOOK_NAME);
  if (!fs.existsSync(hookFile)) {
    console.warn(`⚠️  ${HOOKS_DIR}/${HOOK_NAME} が見つかりません。フックの導入をスキップします。`);
    process.exit(0);
  }

  try {
    // git に .githooks を使わせる（.git/hooks を汚さず、フック自体も履歴に残る）
    execFileSync('git', ['config', 'core.hooksPath', HOOKS_DIR], { cwd: ROOT_DIR, stdio: 'inherit' });
    // 実行ビットを立てる（Windows でも git 経由で実行できるように）
    if (process.platform !== 'win32') {
      fs.chmodSync(hookFile, 0o755);
    }
    console.log(`🔒 コミット前スキャンを有効にしました（core.hooksPath=${HOOKS_DIR}）`);
    console.log('   無効化する場合: git config --unset core.hooksPath');
  } catch (err) {
    console.warn('⚠️  git フックの設定に失敗しました（スキャンは npm run check:secrets で実行できます）:', err);
    process.exit(0);
  }
}

main();
