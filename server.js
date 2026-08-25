'use strict';

require('dotenv').config();

/**
 * server.js — Backend cho "Bé Học Đánh Vần"
 * ---------------------------------------------------------------------------
 * Server phục vụ giao diện, manifest và các WAV đã generate từ FPT.
 * Runtime không tự gọi API TTS. Chỉ endpoint generate do người dùng chủ động
 * bấm mới khởi chạy tts-generate.js với token tạm trong memory.
 *
 *  1. Mỗi câu đọc chỉ được generate một lần và lưu trong audio-cache.
 *  2. Tốc độ đọc và khoảng chuyển bước được tách riêng ở phía client.
 *
 * CHẠY THỬ:
 *   npm install
 *   npm start
 *   → mở http://localhost:3000
 */

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const {
  DEFAULT_ROUTE,
  canonicalAudioText,
  isLegacyParserText,
  normalizeCatalog,
  normalizeRoute,
  normalizeRoutesConfig
} = require('./tts-config.js');
const {
  buildTextPlan,
  configFingerprint,
  normalizeWav,
  readCatalog
} = require('./tts-generate.js');
const {
  initDatabase,
  upsertGoogleUser,
  listUsers,
  deleteUser
} = require('./db.js');
const {
  verifyGoogleCredential,
  exchangeGoogleCode,
  issueToken,
  authenticateRequest,
  requireAdmin,
  setSessionCookie,
  clearSessionCookie
} = require('./auth.js');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = __dirname;
const AUDIO_DIR = path.join(PUBLIC_DIR, 'audio-cache');
const DATA_PATH = path.join(PUBLIC_DIR, 'data.json');
const ROUTES_PATH = path.join(PUBLIC_DIR, 'tts-routes.json');
const CATALOG_PATH = path.join(PUBLIC_DIR, 'tts-catalog.json');
const MANIFEST_PATH = path.join(AUDIO_DIR, 'manifest.json');
const LOCK_PATH = path.join(AUDIO_DIR, '.generate.lock');
const TRAILING_SILENCE_SECONDS = 0.1;

const DEFAULT_VOICE = DEFAULT_ROUTE.voice;
const app = express();
const jobs = new Map();
let activeJobId = null;

const PUBLIC_FRONTEND_ORIGIN = 'https://morazala.github.io';
const allowedOrigins = new Set(
  String(process.env.ALLOWED_ORIGINS || process.env.FRONTEND_ORIGIN || PUBLIC_FRONTEND_ORIGIN)
    .split(',').map(origin => origin.trim().replace(/\/+$/, '')).filter(Boolean)
);

app.disable('x-powered-by');
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginResourcePolicy: false,
  // Google Identity Services cần được phép kiểm tra trạng thái popup.
  crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' }
}));
app.use(cors({
  credentials: true,
  origin(origin, callback) {
    if (!origin || allowedOrigins.has(origin) || (process.env.NODE_ENV !== 'production' && allowedOrigins.size === 0)) return callback(null, origin || true);
    return callback(new Error('Origin không được phép.'));
  }
}));
app.use(rateLimit({ windowMs: 15 * 60 * 1000, limit: 240, standardHeaders: 'draft-7', legacyHeaders: false }));
const authRateLimit = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: 'draft-7', legacyHeaders: false });
app.use(express.json({ limit: '1mb' }));

// Giữ workflow local hiện tại không cần secret; mọi môi trường production
// bắt buộc đi qua Admin Secret trước khi sửa route/catalog/cache.
const adminMutationGuard = (req, res, next) => process.env.NODE_ENV === 'production'
  ? requireAdmin(req, res, next)
  : next();

const noCacheSource = {
  setHeaders(res, filePath) {
    if (/\.(html|css|js|json)$/i.test(filePath)) res.setHeader('Cache-Control', 'no-store');
  }
};

app.get('/api/health', (req, res) => {
  res.json({ ok: true, service: 'be-hoc-danh-van', database: Boolean(process.env.DATABASE_URL) });
});

app.post('/api/auth/google', authRateLimit, async (req, res) => {
  try {
    // GIS OAuth popup trả về authorization code. Credential vẫn được giữ để
    // tương thích với các client cũ dùng ID token.
    const payload = req.body?.code
      ? await exchangeGoogleCode(req.body.code)
      : await verifyGoogleCredential(req.body?.credential);
    const user = await upsertGoogleUser({
      googleId: payload.sub,
      email: payload.email,
      displayName: payload.name,
      avatarUrl: payload.picture,
      deviceInfo: req.body?.deviceInfo,
      userAgent: req.get('user-agent')
    });
    setSessionCookie(res, issueToken(user));
    res.json({ ok: true, user });
  } catch (error) {
    const status = error.code === 'USER_DISABLED' ? 403 : 401;
    res.status(status).json({ ok: false, error: error.message || 'Đăng nhập Google thất bại.' });
  }
});

app.get('/api/auth/me', authenticateRequest, (req, res) => {
  res.json({ ok: true, user: req.user });
});

app.post('/api/auth/logout', (req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

app.get('/api/admin/users', requireAdmin, async (req, res) => {
  try {
    res.json({ ok: true, users: await listUsers() });
  } catch (error) {
    res.status(503).json({ ok: false, error: error.message || 'Database chưa sẵn sàng.' });
  }
});

app.delete('/api/admin/users/:id', requireAdmin, async (req, res) => {
  try {
    const user = await deleteUser(String(req.params.id || ''));
    if (!user) return res.status(404).json({ ok: false, error: 'Không tìm thấy tài khoản.' });
    return res.json({ ok: true, user });
  } catch (error) {
    return res.status(503).json({ ok: false, error: error.message || 'Database chưa sẵn sàng.' });
  }
});

function normalizeUploadedText(value) {
  return String(value || '').normalize('NFC').trim().replace(/\s+/g, ' ');
}

function safeFilePart(value) {
  return normalizeUploadedText(value)
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/\s+/g, '_')
    .slice(0, 80) || 'cache';
}

function downloadFileName(entry) {
  return `${safeFilePart(entry.text)}__${safeFilePart(entry.model)}__${safeFilePart(entry.voice)}.wav`;
}

async function writeBinaryAtomic(filePath, buffer) {
  const tempPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.writeFile(tempPath, buffer);
    await fs.rename(tempPath, filePath);
  } catch (error) {
    if (!['EPERM', 'EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error;
    await fs.rm(filePath, { force: true });
    await fs.rename(tempPath, filePath);
  } finally {
    await fs.rm(tempPath, { force: true }).catch(() => {});
  }
}

async function generationLockExists() {
  try {
    await fs.access(LOCK_PATH);
    return true;
  } catch {
    return false;
  }
}

// Manifest thường được cập nhật trong lúc generate. Không stream file tĩnh vì
// Windows có thể thay file đúng lúc Content-Length đã được tính, khiến browser
// báo ERR_CONTENT_LENGTH_MISMATCH. Đọc xong JSON vào memory rồi mới gửi response.
app.get('/api/manifest', async (req, res) => {
  const manifest = await readManifest();
  res.setHeader('Cache-Control', 'no-store');
  res.json(activeManifest(manifest));
});

// Phục vụ luôn các file tĩnh của trang (index.html, script.js, style.css,
// phonics-parser.js, data.json) để không cần chạy 2 server song song.
app.use(express.static(PUBLIC_DIR, noCacheSource));
app.use('/audio', express.static(AUDIO_DIR, { fallthrough: true, immutable: true, maxAge: '1y' }));

async function readRoutes() {
  const catalog = await readCatalog();
  try {
    const parsed = JSON.parse(await fs.readFile(ROUTES_PATH, 'utf8'));
    return normalizeRoutesConfig(parsed, catalog);
  } catch {
    return normalizeRoutesConfig({ default: DEFAULT_ROUTE, routes: {} }, catalog);
  }
}

async function writeRoutes(config) {
  await writeJsonAtomic(ROUTES_PATH, config);
}

async function writeJsonAtomic(filePath, value) {
  const tempPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.writeFile(tempPath, JSON.stringify(value, null, 2) + '\n', 'utf8');
    await fs.rename(tempPath, filePath);
  } catch (error) {
    if (!['EPERM', 'EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error;
    await fs.rm(filePath, { force: true });
    await fs.rename(tempPath, filePath);
  } finally {
    await fs.rm(tempPath, { force: true }).catch(() => {});
  }
}

async function readManifest() {
  // Khi Windows đang thay file manifest, có một khoảng rất ngắn file chưa xuất
  // hiện. Retry nhỏ giúp API không trả manifest rỗng và không làm client rơi về
  // cache mặc định trong thời điểm đó.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const manifest = JSON.parse(await fs.readFile(MANIFEST_PATH, 'utf8'));
      return manifest?.schemaVersion === 1 && manifest.entries ? manifest : {
        schemaVersion: 1, entries: {}
      };
    } catch {
      if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 20));
    }
  }
  return { schemaVersion: 1, entries: {} };
}

function activeManifest(manifest) {
  const entries = Object.fromEntries(Object.entries(manifest.entries || {}).filter(([, entry]) => {
    const raw = normalizeUploadedText(entry.text);
    // Các entry cũ như "op"/"oc" không còn là cache độc lập khi parser đã
    // chuẩn hoá chúng thành "óp"/"óc". Không đưa chúng vào runtime để tránh
    // browser chọn nhầm audio cũ; entry canonical sẽ được plan/manifest dùng.
    return raw && !isLegacyParserText(raw) && canonicalAudioText(raw) === raw;
  }));
  return { ...manifest, entries };
}

async function fileExists(fileName) {
  if (!fileName || path.basename(fileName) !== fileName) return false;
  try {
    await fs.access(path.join(AUDIO_DIR, fileName));
    return true;
  } catch {
    return false;
  }
}

async function buildCacheStatus() {
  const catalog = await readCatalog();
  const routes = await readRoutes();
  const plan = buildTextPlan(routes);
  const manifest = activeManifest(await readManifest());
  const variantsByText = new Map();
  for (const entry of Object.values(manifest.entries)) {
    const text = canonicalAudioText(entry.text);
    if (!text) continue;
    const variants = variantsByText.get(text) || [];
    variants.push({
      hash: entry.hash,
      text,
      model: entry.model || manifest.model || DEFAULT_ROUTE.model,
      voice: entry.voice || manifest.voice || DEFAULT_VOICE,
      file: entry.file || null,
      status: entry.status || 'planned',
      bytes: Number(entry.bytes) || 0,
      error: entry.error || null,
      uses: Number(entry.uses) || 0
    });
    variantsByText.set(text, variants);
  }

  let ready = 0;
  const items = [];
  for (const item of plan) {
    const entry = manifest.entries[item.hash];
    const hasFile = entry?.status === 'ready' && await fileExists(entry.file);
    const status = hasFile ? 'ready' : (entry?.status || 'missing');
    if (status === 'ready') ready++;
    const variants = variantsByText.get(item.text) || [];
    if (!variants.some(variant => variant.hash === item.hash)) {
      variants.push({
        hash: item.hash, text: item.text, model: item.model, voice: item.voice,
        file: entry?.file || null, status, bytes: Number(entry?.bytes) || 0,
        error: entry?.error || null, uses: item.uses
      });
      variantsByText.set(item.text, variants);
    }
    items.push({
      hash: item.hash,
      text: item.text,
      model: item.model,
      voice: item.voice,
      uses: item.uses,
      status,
      error: entry?.error || null,
      variants
    });
  }
  items.sort((a, b) => a.text.localeCompare(b.text, 'vi'));

  return {
    generatedAt: manifest.generatedAt || null,
    total: plan.length,
    ready,
    missing: plan.length - ready,
    catalog,
    routes,
    items,
    job: activeJobId ? jobs.get(activeJobId) : null
  };
}

app.get('/api/voices', async (req, res) => {
  const voices = await readCatalog();
  res.json({ voices, defaultVoice: DEFAULT_VOICE });
});

app.get('/api/cache-routes', async (req, res) => {
  const routes = await readRoutes();
  const catalog = await readCatalog();
  res.setHeader('Cache-Control', 'no-store');
  res.json({ ...routes, catalog });
});

app.put('/api/cache-routes', adminMutationGuard, async (req, res) => {
  try {
    const catalog = await readCatalog();
    const routes = normalizeRoutesConfig(req.body, catalog);
    await writeRoutes(routes);
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ok: true, ...routes, catalog });
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message || 'Không lưu được route cache.' });
  }
});

app.get('/api/settings', async (req, res) => {
  const status = await buildCacheStatus();
  res.setHeader('Cache-Control', 'no-store');
  res.json({ ...status, tokenConfigured: false });
});

app.put('/api/catalog', adminMutationGuard, async (req, res) => {
  try {
    const catalog = normalizeCatalog(req.body?.catalog || req.body);
    await writeJsonAtomic(CATALOG_PATH, catalog);
    const routes = await readRoutes();
    res.json({ ok: true, catalog, routes });
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message || 'Không lưu được danh mục voice.' });
  }
});

app.get('/api/cache/:hash/download', async (req, res) => {
  const hash = String(req.params.hash || '');
  if (!/^[a-f0-9]{64}$/.test(hash)) return res.status(400).json({ ok: false, error: 'Hash cache không hợp lệ.' });
  try {
    const manifest = await readManifest();
    const entry = manifest.entries[hash];
    const rawText = normalizeUploadedText(entry?.text);
    if (!entry || isLegacyParserText(rawText) || canonicalAudioText(rawText) !== rawText || entry.status !== 'ready' || !entry.file || path.basename(entry.file) !== entry.file) {
      return res.status(404).json({ ok: false, error: 'Cache này chưa có file âm thanh để tải.' });
    }
    const filePath = path.join(AUDIO_DIR, entry.file);
    await fs.access(filePath);
    const fileName = downloadFileName(entry);
    const asciiName = fileName.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^\x20-\x7e]/g, '_');
    res.setHeader('Content-Type', 'audio/wav');
    res.setHeader('Content-Disposition', `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(fileName)}`);
    res.setHeader('Cache-Control', 'no-store');
    return res.sendFile(filePath);
  } catch (error) {
    return res.status(404).json({ ok: false, error: 'Không tìm thấy file âm thanh của cache.' });
  }
});

// Người dùng có thể thay audio đã tải xuống bằng file WAV tự chỉnh. Route này
// chỉ ghi file/manifest, tuyệt đối không gọi TTS và không cần token.
app.post('/api/cache/upload', adminMutationGuard, express.raw({
  type: ['audio/wav', 'audio/x-wav', 'application/octet-stream'],
  limit: '20mb'
}), async (req, res) => {
  try {
    if (await generationLockExists()) return res.status(409).json({ ok: false, error: 'Đang generate, hãy nạp audio sau khi job kết thúc.' });
    const text = canonicalAudioText(normalizeUploadedText(req.query.text));
    if (!text) return res.status(400).json({ ok: false, error: 'Thiếu text của cache.' });
    const catalog = await readCatalog();
    const route = normalizeRoute({ model: req.query.model, voice: req.query.voice }, catalog);
    if (!route) return res.status(400).json({ ok: false, error: 'Model/voice không có trong danh mục.' });
    const audio = normalizeWav(Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0));
    if (!audio) return res.status(400).json({ ok: false, error: 'File không phải WAV hợp lệ.' });

    const hash = configFingerprint(text, route.model, route.voice);
    const file = `${hash}.wav`;
    const manifest = await readManifest();
    const previous = manifest.entries[hash] || {};
    const entry = {
      hash,
      text,
      model: route.model,
      voice: route.voice,
      uses: Number(previous.uses) || 0,
      stepTypes: Array.isArray(previous.stepTypes) && previous.stepTypes.length ? previous.stepTypes : ['uploaded'],
      words: Array.isArray(previous.words) ? previous.words : [],
      status: 'ready',
      file,
      bytes: audio.length,
      trailingSilenceSeconds: TRAILING_SILENCE_SECONDS,
      error: null,
      requestedAt: previous.requestedAt || null,
      uploadedAt: new Date().toISOString()
    };
    await writeBinaryAtomic(path.join(AUDIO_DIR, file), audio);
    manifest.entries[hash] = entry;
    manifest.generatedAt = new Date().toISOString();
    await writeJsonAtomic(MANIFEST_PATH, manifest);
    return res.json({ ok: true, entry, apiCalled: false });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message || 'Không nạp được audio cache.' });
  }
});

app.delete('/api/cache/:hash', adminMutationGuard, async (req, res) => {
  const hash = String(req.params.hash || '');
  if (!/^[a-f0-9]{64}$/.test(hash)) return res.status(400).json({ ok: false, error: 'Hash cache không hợp lệ.' });
  try {
    try { await fs.access(LOCK_PATH); return res.status(409).json({ ok: false, error: 'Đang generate, hãy xoá cache sau khi job kết thúc.' }); } catch {}
    const manifest = await readManifest();
    const entry = manifest.entries[hash];
    if (!entry) return res.status(404).json({ ok: false, error: 'Không tìm thấy cache.' });
    delete manifest.entries[hash];
    if (entry.file && path.basename(entry.file) === entry.file) {
      await fs.rm(path.join(AUDIO_DIR, entry.file), { force: true });
    }
    await writeJsonAtomic(MANIFEST_PATH, manifest);
    res.json({ ok: true, hash });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message || 'Không xoá được cache.' });
  }
});

app.post('/api/cache/generate', adminMutationGuard, async (req, res) => {
  if (activeJobId) return res.status(409).json({ ok: false, error: 'Đang có một job generate khác.', jobId: activeJobId });
  const token = String(req.body?.token || '').trim();
  if (!token) return res.status(400).json({ ok: false, error: 'Cần nhập FPT API token.' });
  const args = ['tts-generate.js'];
  if (Number.isFinite(Number(req.body?.limit)) && Number(req.body.limit) > 0) args.push('--limit', String(Math.floor(Number(req.body.limit))));
  if (Number.isFinite(Number(req.body?.concurrency)) && Number(req.body.concurrency) > 0) args.push('--concurrency', String(Math.min(2, Math.floor(Number(req.body.concurrency)))));
  if (req.body?.text) args.push('--text', String(req.body.text));
  if (req.body?.route?.model) args.push('--model', String(req.body.route.model));
  if (req.body?.route?.voice) args.push('--voice', String(req.body.route.voice));
  const jobId = crypto.randomUUID();
  const job = { id: jobId, status: 'running', output: [], startedAt: new Date().toISOString(), finishedAt: null, exitCode: null };
  jobs.set(jobId, job);
  activeJobId = jobId;
  // Token chỉ sống trong memory của server và tiến trình con; không ghi file,
  // không đưa vào log/job response và không trả lại cho client.
  const child = spawn(process.execPath, args, {
    cwd: PUBLIC_DIR,
    env: { ...process.env, FPT_TTS_API_KEY: token },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const append = chunk => {
    job.output.push(String(chunk).replace(token, '[TOKEN]'));
    if (job.output.length > 200) job.output.splice(0, job.output.length - 200);
  };
  child.stdout.on('data', append);
  child.stderr.on('data', append);
  child.on('close', code => {
    job.status = code === 0 ? 'completed' : 'failed';
    job.exitCode = code;
    job.finishedAt = new Date().toISOString();
    activeJobId = null;
  });
  res.status(202).json({ ok: true, jobId });
});

app.get('/api/cache/generate/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ ok: false, error: 'Không tìm thấy job.' });
  res.json({ ...job, output: job.output.slice(-40).join('') });
});

app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  console.error('[API]', error.message || error);
  return res.status(error.status || 500).json({ ok: false, error: 'Máy chủ gặp lỗi; vui lòng thử lại sau.' });
});

async function start() {
  try {
    const database = await initDatabase();
    console.log(`[DB] ${database.ready ? 'PostgreSQL sẵn sàng.' : 'Chưa cấu hình DATABASE_URL; auth/admin sẽ tạm tắt.'}`);
  } catch (error) {
    console.error('[DB] Không khởi tạo được schema:', error.message);
  }
  app.listen(PORT, () => {
    console.log(`Bé Học Đánh Vần đang chạy tại http://localhost:${PORT}`);
    console.log('[TTS] Runtime chỉ phát audio-cache; generate chỉ chạy khi người dùng chủ động bấm.');
  });
}

if (require.main === module) start();

module.exports = { app, start };
