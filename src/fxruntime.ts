import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, TMP_DIR } from './config.js';
import { runFfmpeg, type VideoInfo } from './ffmpeg.js';
import type { FxCue } from './fx-catalog.js';

export const FX_RENDERER_DIR = path.join(ROOT, 'fx-renderer');

function envOne(key: string, dflt: string): string {
  const v = process.env[key];
  return v && v !== '' ? v : dflt;
}

export const FX_PATHS = {
  cargoHome: () => envOne('FX_CARGO_HOME', 'D:\\cargo-home'),
  targetDir: () => envOne('FX_TARGET_DIR', 'D:\\fx-target'),
  ffmpegDir: () => envOne('FX_FFMPEG_DIR', 'D:\\ffmpeg-n9.0-latest-win64-gpl-shared-9.0'),
  libclang: () => envOne('FX_LIBCLANG_PATH', 'D:\\llvm-extract\\bin'),
  tmp: () => envOne('FX_TMP', 'D:\\tmp'),
};

/** Env untuk cargo build & menjalankan fx-renderer (DLL FFmpeg + libclang harus terlihat). */
export function fxEnv(): NodeJS.ProcessEnv {
  const p = FX_PATHS;
  const ffmpegBin = path.join(p.ffmpegDir(), 'bin');
  return {
    ...process.env,
    CARGO_HOME: p.cargoHome(),
    CARGO_TARGET_DIR: p.targetDir(),
    TEMP: p.tmp(),
    TMP: p.tmp(),
    TMPDIR: p.tmp(),
    LIBCLANG_PATH: p.libclang(),
    FFMPEG_DIR: p.ffmpegDir(),
    PATH: `${p.libclang()};${ffmpegBin};${process.env.PATH ?? ''}`,
  };
}

export function fxBinaryPath(): string {
  return path.join(FX_PATHS.targetDir(), 'release', 'fx-renderer.exe');
}

function run(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; onLine?: (line: string) => void }
): Promise<{ code: number; out: string }> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd: opts.cwd, env: opts.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let buf = '';
    const timer = setTimeout(() => {
      p.kill('SIGKILL');
      reject(new Error(`timeout ${opts.timeoutMs! / 1000}s: ${cmd} ${args.join(' ')}`));
    }, opts.timeoutMs ?? 600_000);
    const onData = (d: Buffer) => {
      out += d;
      buf += d;
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).replace(/\x1b\[[0-9;]*m/g, '');
        buf = buf.slice(i + 1);
        if (/error(\[|:| )|Finished|Compiling fx-renderer/i.test(line)) opts.onLine?.(line.trim());
      }
      if (out.length > 400_000) out = out.slice(-200_000);
    };
    p.stdout.on('data', onData);
    p.stderr.on('data', onData);
    p.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    p.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, out });
    });
  });
}

const GENERATED_TEMPLATE = (w: number, h: number, fps: number) =>
  `// Otomatis ditulis oleh pipeline AutoTimingSFX — jangan edit manual.\n` +
  `pub const WIDTH: usize = ${w};\n` +
  `pub const HEIGHT: usize = ${h};\n` +
  `pub const FPS: usize = ${fps};\n`;

/**
 * Tulis generated.rs (dimensi/fps target) lalu build fx-renderer.
 * Build selalu dijalankan — cargo cepat kalau sudah fresh dan otomatis
 * recompile hanya crate kita kalau generated.rs berubah.
 */
export async function ensureFxRenderer(
  width: number,
  height: number,
  fps: number,
  log: (m: string) => void
): Promise<string> {
  const genPath = path.join(FX_RENDERER_DIR, 'src', 'generated.rs');
  const want = GENERATED_TEMPLATE(width, height, fps);
  let cur = '';
  try {
    cur = fs.readFileSync(genPath, 'utf8');
  } catch {
    /* belum ada */
  }
  if (cur !== want) {
    fs.writeFileSync(genPath, want);
    log(`fx: generated.rs → ${width}x${height}@${fps}`);
  }
  const exe = fxBinaryPath();
  const needBuild = !fs.existsSync(exe);
  log(needBuild ? 'fx: build fx-renderer (pertama kali, bisa lama)…' : 'fx: build fx-renderer…');
  const t0 = Date.now();
  const r = await run('cargo', ['build', '--release'], {
    cwd: FX_RENDERER_DIR,
    env: fxEnv(),
    timeoutMs: 45 * 60_000,
    onLine: (l) => log(`fx build: ${l.slice(0, 200)}`),
  });
  if (r.code !== 0 || !fs.existsSync(exe)) {
    const tail = r.out.split(/\r?\n/).filter((l) => l.trim()).slice(-12).join('\n');
    throw new Error(`fx-renderer build gagal (exit ${r.code}):\n${tail}`);
  }
  log(`fx: build OK (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  return exe;
}

export interface FxSpecFile {
  clip: string;
  width: number;
  height: number;
  fps: number;
  duration: number;
  cues: FxCue[];
}

/** Tulis fx_spec.json (juga jadi artifact yang bisa diunduh user). */
export function writeFxSpec(jobDir: string, spec: FxSpecFile): string {
  const p = path.join(jobDir, 'fx_spec.json');
  fs.writeFileSync(p, JSON.stringify(spec, null, 2));
  return p;
}

/** Render video + vfx → mp4 senyap lewat sidecar fx-renderer (fframes/Skia). */
export async function renderFxVideo(opts: {
  exe: string;
  specPath: string;
  video: string;
  outPath: string;
  log: (m: string) => void;
}): Promise<void> {
  const { exe, specPath, video, outPath, log } = opts;
  log('fx: render visual (sidecar)…');
  const t0 = Date.now();
  const r = await run(exe, ['--spec', specPath, '--video', video, 'render', '-o', outPath], {
    cwd: FX_RENDERER_DIR,
    env: fxEnv(),
    timeoutMs: 20 * 60_000,
    onLine: (l) => {
      if (!/^\s*\d+%\|/.test(l)) log(`fx render: ${l.slice(0, 200)}`);
    },
  });
  if (r.code !== 0 || !fs.existsSync(outPath)) {
    const tail = r.out.split(/\r?\n/).filter((l) => l.trim()).slice(-15).join('\n');
    throw new Error(`fx-renderer render gagal (exit ${r.code}):\n${tail}`);
  }
  log(`fx: render visual selesai (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
}

export interface FxVideoPlan {
  /** path video yang dibaca sidecar (asli atau hasil normalisasi) */
  clipPath: string;
  width: number;
  height: number;
  fps: number;
}

/**
 * Samakan format video sumber dengan yang bisa dirender sidecar:
 * - sisi panjang > 1920 → scale down; dimensi ganjil → bulatkan genap
 * - fps > 30 atau pecahan (29.97 dst) → 30
 * Kalau sudah cocok → pakai file asli tanpa re-encode.
 */
export async function prepareFxClip(src: string, info: VideoInfo, log: (m: string) => void): Promise<FxVideoPlan> {
  const cap = 1920;
  const scale = Math.min(1, cap / Math.max(info.width, info.height));
  const even = (n: number) => Math.max(2, Math.round((n * scale) / 2) * 2);
  const tw = even(info.width);
  const th = even(info.height);
  const fpsRaw = info.fps;
  const fps = Number.isInteger(fpsRaw) && fpsRaw > 0 && fpsRaw <= 30 ? fpsRaw : 30;

  const needScale = tw !== info.width || th !== info.height;
  const needFps = Math.abs(fps - fpsRaw) > 0.02;
  if (!needScale && !needFps) {
    return { clipPath: src, width: tw, height: th, fps };
  }
  const out = path.join(TMP_DIR, `fxin_${Date.now()}_${path.basename(src, path.extname(src))}.mp4`);
  const args = ['-i', src];
  if (needScale) args.push('-vf', `scale=${tw}:${th}`);
  if (needFps) args.push('-r', String(fps));
  args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '16', '-c:a', 'copy', '-movflags', '+faststart', out);
  log(`fx: normalisasi video → ${tw}x${th}@${fps}fps`);
  await runFfmpeg(args);
  return { clipPath: out, width: tw, height: th, fps };
}
