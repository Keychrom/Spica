import { spawn } from 'node:child_process';
import path from 'node:path';

const ROOT_DIR = process.cwd();

console.log(`
=====================================================
🌐 SN-SNS 分散型ソーシャルネットワーク起動スクリプト
=====================================================
1. Node A: http://localhost:3000
2. Node B: http://localhost:3001
3. Web UI: http://localhost:5173
=====================================================
`);

const processes = [];

function startProcess(name, cmd, args, cwd, env = {}) {
  const p = spawn(cmd, args, {
    cwd,
    env: { ...process.env, ...env },
    shell: true,
    stdio: 'inherit',
  });
  processes.push(p);
  return p;
}

// 1. Node A (3000)
startProcess(
  'Node-A',
  'npx',
  ['tsx', 'watch', 'src/index.ts'],
  path.resolve(ROOT_DIR, 'server'),
  { PORT: '3000', DOMAIN: 'localhost:3000', INSTANCE_NAME: 'Node-A' }
);

// 2. Node B (3001)
startProcess(
  'Node-B',
  'npx',
  ['tsx', 'watch', 'src/index.ts'],
  path.resolve(ROOT_DIR, 'server'),
  { PORT: '3001', DOMAIN: 'localhost:3001', INSTANCE_NAME: 'Node-B' }
);

// 3. Client UI (5173)
startProcess(
  'Client-UI',
  'npm',
  ['run', 'dev'],
  path.resolve(ROOT_DIR, 'client')
);

// 終了ハンドリング
process.on('SIGINT', () => {
  console.log('\n🛑 全プロセスを停止中...');
  processes.forEach((p) => {
    if (p && p.pid) {
      try {
        spawn('taskkill', ['/pid', p.pid.toString(), '/f', '/t'], { shell: true });
      } catch {}
    }
  });
  process.exit();
});
