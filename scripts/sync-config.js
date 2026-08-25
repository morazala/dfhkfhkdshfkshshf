'use strict';

/*
 * sync-config.js — đồng bộ cấu hình cache/audio từ localhost lên GitHub.
 *
 * Theo dõi: data.json, tts-routes.json, tts-catalog.json,
 * audio-cache/manifest.json và mọi file WAV trong audio-cache/.
 * Khi bạn chỉnh route/model giọng trên web local, upload giọng từ máy,
 * hay generate cache... script chờ cho file ổn định rồi:
 *   git add <đúng các file đổi> → git commit → git push <remote> <branch>
 * GitHub Pages sẽ tự build lại (~1-2 phút) và static web nhận cấu hình mới.
 *
 * Chạy: tự khởi động cùng `npm start` ở máy local (bỏ qua khi production),
 * hoặc chạy riêng `npm run sync`.
 * Tắt: CONFIG_SYNC=off npm start.
 * Đổi nơi đẩy: SYNC_REMOTE (mặc định deploy), SYNC_BRANCH (mặc định main).
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const REMOTE = String(process.env.SYNC_REMOTE || 'deploy');
const BRANCH = String(process.env.SYNC_BRANCH || 'main');
const DEBOUNCE_MS = Math.max(2000, Number(process.env.SYNC_DEBOUNCE_MS || 8000));
const RETRY_MS = 30_000;

const WATCH_FILES = new Set(['data.json', 'tts-routes.json', 'tts-catalog.json', 'audio-cache/manifest.json']);
const AUDIO_DIR = path.join(ROOT, 'audio-cache');

const pending = new Set();
let debounceTimer = null;
let syncInFlight = false;

function log(message) {
  console.log(`[sync] ${message}`);
}

function git(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd: ROOT, windowsHide: true });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) return resolve(output.trim());
      reject(new Error(output.trim() || `git ${args.join(' ')} thoát với mã ${code}`));
    });
  });
}

function scheduleSync(delay) {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(runSync, delay);
}

function queueChange(relPath) {
  pending.add(relPath);
  log(`Phát hiện thay đổi: ${relPath} → sẽ đẩy sau ${Math.round(DEBOUNCE_MS / 1000)}s nếu không còn thay đổi mới.`);
  scheduleSync(DEBOUNCE_MS);
}

async function runSync() {
  if (syncInFlight || !pending.size) return;
  syncInFlight = true;
  const files = [...pending];
  try {
    await git(['add', '--', ...files]);
    const staged = await git(['diff', '--cached', '--name-only', '--', ...files]);
    pending.clear();
    if (!staged.trim()) {
      log('Nội dung trùng với remote, không cần đẩy.');
      return;
    }
    const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
    await git(['commit', '-m', `Sync cache config from localhost (${stamp})`]);
    await git(['push', REMOTE, BRANCH]);
    log(`Đã đẩy ${staged.split('\n').length} file lên ${REMOTE}/${BRANCH}. GitHub Pages sẽ tự build lại trong ~1-2 phút.`);
  } catch (error) {
    log(`Lỗi đồng bộ, sẽ thử lại sau ${Math.round(RETRY_MS / 1000)}s: ${error.message}`);
    scheduleSync(RETRY_MS);
  } finally {
    syncInFlight = false;
  }
}

function watchConfigFiles() {
  fs.watch(ROOT, { persistent: true }, (_, filename) => {
    if (!filename) return;
    const rel = String(filename).replace(/\\/g, '/');
    if (WATCH_FILES.has(rel)) queueChange(rel);
  });
}

function watchAudioCache() {
  if (!fs.existsSync(AUDIO_DIR)) return;
  fs.watch(AUDIO_DIR, { persistent: true }, (_, filename) => {
    if (!filename) {
      queueChange('audio-cache');
      return;
    }
    const rel = `audio-cache/${String(filename).replace(/\\/g, '/')}`;
    if (rel.endsWith('.wav') || rel.endsWith('.json')) queueChange(rel);
  });
}

async function main() {
  if (process.env.NODE_ENV === 'production') {
    log('NODE_ENV=production → không chạy đồng bộ (chỉ dành cho máy local).');
    return;
  }
  try {
    await git(['remote', 'get-url', REMOTE]);
  } catch (_) {
    log(`Không tìm thấy git remote "${REMOTE}" → đồng bộ tắt. Dùng SYNC_REMOTE để đổi remote.`);
    return;
  }
  watchConfigFiles();
  watchAudioCache();
  log(`Đang theo dõi data.json, tts-routes.json, tts-catalog.json, audio-cache/ → đẩy lên ${REMOTE}/${BRANCH}.`);
}

main();
