import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';

/**
 * 動画のサムネイル（ポスター）生成
 *
 *  ・ffmpeg / ffprobe がある場合のみ動く（無ければ静かに無効化する）
 *  ・動画の 1 秒地点（短い動画は先頭）から 1 フレームを WebP として抜き出す
 *  ・ffprobe があれば幅・高さ・再生時間も取得する
 *
 * ffmpeg は必須ではない。未インストールでもアップロードは成功し、
 * クライアントは従来どおり video 要素で再生する（サムネイルだけが付かない）。
 */

export interface VideoPoster {
  buffer: Buffer;
  mediaType: string;
  width: number | null;
  height: number | null;
  duration: number | null;
}

let cachedAvailable: boolean | null = null;

/** ffmpeg が使えるか（結果はプロセス内でキャッシュする） */
export async function isFfmpegAvailable(): Promise<boolean> {
  if (cachedAvailable !== null) return cachedAvailable;
  // 存在確認も run() 経由にする（.cmd ラッパーや実行権限の扱いを揃えるため）
  const result = await run(config.ffmpegPath, ['-version'], 5000);
  cachedAvailable = result.code === 0;
  if (!cachedAvailable) {
    console.log('[Video] ffmpeg が見つからないため、動画のサムネイル生成は行いません（インストールすると有効になります）');
  } else {
    console.log('[Video] ffmpeg を検出しました（動画サムネイルを生成します）');
  }
  return cachedAvailable;
}

function run(command: string, args: string[], timeoutMs: number): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      resolve({ code, stdout, stderr });
    };
    try {
      // Windows では .cmd / .bat のラッパー（ラッパースクリプト等）も指定できるようにする
      const needsShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(command);
      const spawnArgs = needsShell ? args.map((a) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)) : args;
      const child = spawn(command, spawnArgs, { stdio: ['ignore', 'pipe', 'pipe'], shell: needsShell, windowsHide: true });
      child.stdout?.on('data', (d) => { stdout += d.toString(); });
      child.stderr?.on('data', (d) => { stderr += d.toString(); });
      child.on('error', () => finish(null));
      child.on('exit', (code) => finish(code));
      setTimeout(() => {
        try { child.kill('SIGKILL'); } catch {}
        finish(null);
      }, timeoutMs);
    } catch {
      finish(null);
    }
  });
}

/** ffprobe で動画の幅・高さ・再生時間を取得する（無ければ null） */
async function probeVideo(inputPath: string): Promise<{ width: number | null; height: number | null; duration: number | null }> {
  const result = await run(
    config.ffprobePath,
    ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,duration', '-show_entries', 'format=duration', '-of', 'json', inputPath],
    15000,
  );
  if (result.code !== 0 || !result.stdout) return { width: null, height: null, duration: null };
  try {
    const parsed = JSON.parse(result.stdout);
    const stream = Array.isArray(parsed?.streams) ? parsed.streams[0] : null;
    const duration = Number(stream?.duration ?? parsed?.format?.duration);
    return {
      width: Number.isFinite(Number(stream?.width)) ? Number(stream.width) : null,
      height: Number.isFinite(Number(stream?.height)) ? Number(stream.height) : null,
      duration: Number.isFinite(duration) && duration > 0 ? duration : null,
    };
  } catch {
    return { width: null, height: null, duration: null };
  }
}

/**
 * 動画からサムネイル（WebP 1 フレーム）を生成する。
 * ffmpeg が無い / 失敗した場合は null を返す（呼び出し側はサムネイル無しで保存する）。
 */
export async function generateVideoPoster(params: {
  buffer: Buffer;
  originalname: string;
}): Promise<VideoPoster | null> {
  if (!(await isFfmpegAvailable())) return null;

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spica-video-'));
  const ext = path.extname(params.originalname).replace(/^\./, '') || 'bin';
  const inputPath = path.join(tmpDir, `input_${crypto.randomBytes(4).toString('hex')}.${ext}`);
  const outputPath = path.join(tmpDir, 'poster.webp');

  try {
    fs.writeFileSync(inputPath, params.buffer);

    // 1 秒地点を狙う（1 秒未満の動画では失敗するので先頭フレームで再試行する）
    const attempts: string[][] = [
      ['-ss', '1', '-i', inputPath, '-frames:v', '1', '-vf', 'scale=640:-2', '-y', outputPath],
      ['-i', inputPath, '-frames:v', '1', '-vf', 'scale=640:-2', '-y', outputPath],
    ];
    let produced = false;
    for (const args of attempts) {
      const result = await run(config.ffmpegPath, ['-hide_banner', '-loglevel', 'error', ...args], 60000);
      if (result.code === 0 && fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0) {
        produced = true;
        break;
      }
    }
    if (!produced) {
      console.warn('[Video] サムネイルの生成に失敗しました（動画はそのまま保存します）');
      return null;
    }

    const buffer = fs.readFileSync(outputPath);
    const meta = await probeVideo(inputPath);
    console.log(`[Video] 🎞️ サムネイルを生成しました (${(buffer.length / 1024).toFixed(1)}KB${meta.duration ? `, ${meta.duration.toFixed(1)}秒` : ''})`);
    return { buffer, mediaType: 'image/webp', ...meta };
  } catch (err: any) {
    console.warn('[Video] サムネイル生成エラー:', err?.message || err);
    return null;
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}
