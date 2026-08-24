'use strict';

/**
 * Generate the paid FPT.AI-VITs audio cache once.
 *
 * Safety properties:
 * - no API call is made unless this command is explicitly run;
 * - one unique (model, voice, format, text) gets one cache file;
 * - files are written atomically and validated as WAV;
 * - default concurrency is 1 and failed requests are not retried
 *   automatically, avoiding accidental double billing after a timeout.
 *
 * Usage:
 *   $env:FPT_TTS_API_KEY = '...'
 *   node tts-generate.js --plan-only
 *   node tts-generate.js
 *   node tts-generate.js --limit 10 --concurrency 1
 */

const fs = require('fs/promises');
const fsSync = require('fs');
const path = require('path');
const crypto = require('crypto');
const DATA_PATH = path.join(__dirname, 'data.json');
const { buildSpellingSteps } = require('./phonics-parser.js');
const {
  DEFAULT_ROUTE,
  canonicalAudioText,
  getRouteForText,
  isLegacyParserText,
  normalizeCatalog,
  normalizeRoute,
  normalizeRoutesConfig
} = require('./tts-config.js');

const API_URL = process.env.FPT_TTS_API_URL || 'https://mkp-api.fptcloud.com/v1/audio/speech';
const MODEL = process.env.FPT_TTS_MODEL || 'FPT.AI-VITs';
const VOICE = process.env.FPT_TTS_VOICE || 'std_leminh';
const RESPONSE_FORMAT = 'wav';
const OUTPUT_DIR = path.resolve(process.env.FPT_TTS_OUTPUT_DIR || path.join(__dirname, 'audio-cache'));
const MANIFEST_PATH = path.join(OUTPUT_DIR, 'manifest.json');
const ROUTES_PATH = path.resolve(process.env.FPT_TTS_ROUTES_PATH || path.join(__dirname, 'tts-routes.json'));
const CATALOG_PATH = path.resolve(process.env.FPT_TTS_CATALOG_PATH || path.join(__dirname, 'tts-catalog.json'));
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_CONCURRENCY = 1;
const TRAILING_SILENCE_SECONDS = 0.1;

function parseArgs(argv) {
  const args = {
    planOnly: false,
    repairCache: false,
    retryFailed: false,
    retryRequested: false,
    concurrency: DEFAULT_CONCURRENCY,
    limit: Infinity,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    text: null,
    model: null,
    voice: null,
    help: false
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--plan-only') args.planOnly = true;
    else if (arg === '--repair-cache') args.repairCache = true;
    else if (arg === '--retry-failed') args.retryFailed = true;
    else if (arg === '--retry-requested') args.retryRequested = true;
    else if (arg === '--concurrency') args.concurrency = Math.max(1, Number(argv[++i]) || DEFAULT_CONCURRENCY);
    else if (arg === '--limit') args.limit = Math.max(0, Number(argv[++i]) || 0);
    else if (arg === '--timeout') args.timeoutMs = Math.max(1000, Number(argv[++i]) || DEFAULT_TIMEOUT_MS);
    else if (arg === '--text') args.text = normalizeText(argv[++i] || '');
    else if (arg === '--model') args.model = String(argv[++i] || '').trim();
    else if (arg === '--voice') args.voice = String(argv[++i] || '').trim();
    else if (arg === '--help' || arg === '-h') {
      args.help = true;
    } else {
      throw new Error(`Tham số không hợp lệ: ${arg}`);
    }
  }
  return args;
}

function normalizeText(text) {
  return String(text).normalize('NFC').trim().replace(/\s+/g, ' ');
}

function configFingerprint(text, model = MODEL, voice = VOICE) {
  return crypto.createHash('sha256').update(JSON.stringify({
    provider: 'fptcloud', model, voice,
    responseFormat: RESPONSE_FORMAT, text: normalizeText(text)
  })).digest('hex');
}

function isWav(buffer) {
  return buffer.length >= 44 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WAVE';
}

// Chuẩn hoá WAV tại cache là an toàn, không gọi lại API: sửa header, cắt phần
// im lặng dư ở cuối rồi thêm đúng 0,1 giây im lặng theo sample-rate của file.
function normalizeWav(buffer) {
  if (!isWav(buffer)) return null;
  const output = Buffer.from(buffer);
  let dataPos = 12;
  let fmt = null;
  while (dataPos + 8 <= output.length) {
    const chunkId = output.toString('ascii', dataPos, dataPos + 4);
    const chunkSize = output.readUInt32LE(dataPos + 4);
    if (chunkId === 'fmt ' && chunkSize >= 16 && dataPos + 8 + chunkSize <= output.length) {
      fmt = {
        format: output.readUInt16LE(dataPos + 8),
        channels: output.readUInt16LE(dataPos + 10),
        sampleRate: output.readUInt32LE(dataPos + 12),
        blockAlign: output.readUInt16LE(dataPos + 20),
        bitsPerSample: output.readUInt16LE(dataPos + 22)
      };
    }
    if (chunkId === 'data') break;
    const next = dataPos + 8 + chunkSize + (chunkSize % 2);
    if (next <= dataPos || next > output.length) return null;
    dataPos = next;
  }
  if (dataPos + 8 > output.length || output.toString('ascii', dataPos, dataPos + 4) !== 'data') return null;
  const sourceData = output.subarray(dataPos + 8);
  // Các test/WAV tối giản có thể không có fmt chunk. Vẫn sửa header như trước,
  // nhưng không đoán sample-rate/channels nên không tự thêm im lặng sai format.
  if (!fmt || fmt.format !== 1 || !fmt.channels || !fmt.sampleRate ||
      !fmt.blockAlign || ![8, 16, 24, 32].includes(fmt.bitsPerSample)) {
    const actualDataSize = sourceData.length;
    const actualRiffSize = output.length - 8;
    if (output.readUInt32LE(4) !== actualRiffSize) output.writeUInt32LE(actualRiffSize, 4);
    if (output.readUInt32LE(dataPos + 4) !== actualDataSize) output.writeUInt32LE(actualDataSize, dataPos + 4);
    return output;
  }

  const bytesPerSample = fmt.bitsPerSample / 8;
  const blockAlign = fmt.channels * bytesPerSample;
  if (fmt.blockAlign !== blockAlign || sourceData.length < blockAlign) return null;
  const frameCount = Math.floor(sourceData.length / blockAlign);
  const threshold = Math.max(1, Math.round((2 ** (fmt.bitsPerSample - 1)) * 10 ** (-55 / 20)));
  const samplePeak = (offset, channel) => {
    const pos = offset + channel * bytesPerSample;
    if (fmt.bitsPerSample === 8) return Math.abs(sourceData[pos] - 128);
    if (fmt.bitsPerSample === 16) return Math.abs(sourceData.readInt16LE(pos));
    if (fmt.bitsPerSample === 24) {
      let value = sourceData[pos] | (sourceData[pos + 1] << 8) | (sourceData[pos + 2] << 16);
      if (value & 0x800000) value |= 0xff000000;
      return Math.abs(value);
    }
    return Math.abs(sourceData.readInt32LE(pos));
  };
  let lastAudibleFrame = frameCount - 1;
  while (lastAudibleFrame >= 0) {
    const frameOffset = lastAudibleFrame * blockAlign;
    let peak = 0;
    for (let channel = 0; channel < fmt.channels; channel++) peak = Math.max(peak, samplePeak(frameOffset, channel));
    if (peak > threshold) break;
    lastAudibleFrame--;
  }
  const keptFrames = Math.max(0, lastAudibleFrame + 1);
  const silenceFrames = Math.max(1, Math.round(fmt.sampleRate * TRAILING_SILENCE_SECONDS));
  const normalizedData = Buffer.alloc((keptFrames + silenceFrames) * blockAlign);
  sourceData.copy(normalizedData, 0, 0, keptFrames * blockAlign);
  const header = Buffer.from(output.subarray(0, dataPos + 8));
  header.writeUInt32LE(normalizedData.length, dataPos + 4);
  const result = Buffer.concat([header, normalizedData]);
  result.writeUInt32LE(result.length - 8, 4);
  return result;
}

function buildTextPlan(routeConfig = normalizeRoutesConfig({ default: { model: MODEL, voice: VOICE } }), routeOverrides = {}) {
  const activeRouteConfig = normalizeRoutesConfig(routeConfig);
  // Đọc lại mỗi lần để settings/status thấy data.json mới mà không cần restart
  // server hoặc xoá cache module Node.
  const data = JSON.parse(fsSync.readFileSync(DATA_PATH, 'utf8'));
  const uniqueWords = new Set();
  for (const group of data) {
    if (!group || typeof group.key !== 'string' || !Array.isArray(group.values)) {
      throw new Error('data.json phải là mảng các phần tử { key, values }.');
    }
    for (const word of group.values) {
      const normalizedWord = normalizeText(word);
      if (normalizedWord) uniqueWords.add(normalizedWord);
    }
  }

  const byHash = new Map();
  for (const word of uniqueWords) {
    const result = buildSpellingSteps(word);
    for (const step of result.steps) {
      const text = normalizeText(step.audioText || step.text);
      if (!text) continue;
      // Override theo từ chỉ tồn tại trong một lần "Thêm nhanh". Route đã
      // lưu trong tts-routes.json luôn là route của CACHE ÂM THANH, nên cùng
      // một text phải dùng cùng một model ở mọi từ (óc trong oc, học, ...).
      const wordRoute = routeOverrides[word] || null;
      const route = wordRoute || routeOverrides[text] || getRouteForText(activeRouteConfig, text);
      const hash = configFingerprint(text, route.model, route.voice);
      if (!byHash.has(hash)) {
        byHash.set(hash, {
          hash, text, model: route.model, voice: route.voice, uses: 0,
          stepTypes: new Set(), words: new Set()
        });
      }
      const entry = byHash.get(hash);
      entry.uses++;
      entry.stepTypes.add(step.type);
      entry.words.add(word);
    }
  }

  return [...byHash.values()]
    .sort((a, b) => a.hash.localeCompare(b.hash))
    .map(entry => ({
      hash: entry.hash,
      text: entry.text,
      model: entry.model,
      voice: entry.voice,
      uses: entry.uses,
      stepTypes: [...entry.stepTypes].sort(),
      words: [...entry.words].sort()
    }));
}

function ensureRequestedTextPlan(plan, text, route) {
  const normalized = normalizeText(text);
  if (!normalized || !route?.model || !route?.voice) return plan;
  if (plan.some(item => item.text === normalized && item.model === route.model && item.voice === route.voice)) {
    return plan;
  }
  // Nếu text là một từ trong data.json nhưng không phải là audio step hiện tại
  // (ví dụ "oc" hiện được đánh vần thành "o → cờ → óc"), buildTextPlan đã thêm
  // các step thực tế theo route của từ. Không tạo thêm cache raw "oc" vô dụng.
  const data = JSON.parse(fsSync.readFileSync(DATA_PATH, 'utf8'));
  const isDataWord = data.some(group => Array.isArray(group?.values) &&
    group.values.some(word => normalizeText(word) === normalized));
  if (isDataWord) return plan;
  // "Thêm nhanh" phải dùng được với mọi entry đang có trong manifest, kể cả
  // entry cũ không còn được tham chiếu bởi data.json mới. Đây vẫn là một mục
  // TTS độc lập, được khóa bằng đúng text/model/voice như các mục thông thường.
  return [...plan, {
    hash: configFingerprint(normalized, route.model, route.voice),
    text: normalized,
    model: route.model,
    voice: route.voice,
    uses: 0,
    stepTypes: ['quick'],
    words: []
  }].sort((a, b) => a.hash.localeCompare(b.hash));
}

function requestedTargetTexts(text, basePlan) {
  const normalized = normalizeText(text);
  if (!normalized) return new Set();
  // Khi text vốn là một audio step (ba, cờ, óc...), chỉ tạo đúng cache đó.
  if (basePlan.some(item => item.text === normalized)) return new Set([normalized]);
  const data = JSON.parse(fsSync.readFileSync(DATA_PATH, 'utf8'));
  const isDataWord = data.some(group => Array.isArray(group?.values) &&
    group.values.some(word => normalizeText(word) === normalized));
  if (!isDataWord) return new Set([normalized]);
  const steps = buildSpellingSteps(normalized).steps;
  return new Set(steps.map(step => normalizeText(step.audioText || step.text)).filter(Boolean));
}

async function readCatalog() {
  try {
    return normalizeCatalog(JSON.parse(await fs.readFile(CATALOG_PATH, 'utf8')));
  } catch {
    return normalizeCatalog();
  }
}

async function readRoutesConfig(catalog = normalizeCatalog()) {
  try {
    const parsed = JSON.parse(await fs.readFile(ROUTES_PATH, 'utf8'));
    return normalizeRoutesConfig(parsed, catalog);
  } catch {
    return normalizeRoutesConfig({ default: DEFAULT_ROUTE, routes: {} }, catalog);
  }
}

async function readManifest() {
  try {
    const parsed = JSON.parse(await fs.readFile(MANIFEST_PATH, 'utf8'));
    if (parsed.schemaVersion !== 1 || !parsed.entries || typeof parsed.entries !== 'object') return null;
    return parsed;
  } catch {
    return null;
  }
}

async function writeManifest(manifest) {
  const tempPath = `${MANIFEST_PATH}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await replaceFile(MANIFEST_PATH, tempPath, JSON.stringify(manifest, null, 2) + '\n');
}

async function replaceFile(targetPath, tempPath, content) {
  try {
    await fs.writeFile(tempPath, content, 'utf8');
    await fs.rename(tempPath, targetPath);
  } catch (error) {
    // Windows không cho rename đè lên file đang tồn tại. Chỉ xoá đúng target
    // đã xác định rồi thử lại, không dùng glob hay xoá cả thư mục cache.
    if (!['EPERM', 'EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error;
    await fs.rm(targetPath, { force: true });
    await fs.rename(tempPath, targetPath);
  } finally {
    await fs.rm(tempPath, { force: true }).catch(() => {});
  }
}

function createManifest(plan, previous) {
  const entries = {};
  for (const item of plan) {
    const old = previous?.entries?.[item.hash];
    entries[item.hash] = {
      hash: item.hash,
      text: item.text,
      model: item.model,
      voice: item.voice,
      uses: item.uses,
      stepTypes: item.stepTypes,
      words: item.words,
      status: old?.hash === item.hash && old.text === item.text ? old.status : 'planned',
      file: old?.hash === item.hash && old.text === item.text ? old.file : `${item.hash}.wav`,
      bytes: old?.hash === item.hash && old.text === item.text ? old.bytes : 0,
      error: old?.hash === item.hash && old.text === item.text ? old.error || null : null,
      requestedAt: old?.hash === item.hash && old.text === item.text ? old.requestedAt || null : null,
      uploadedAt: old?.hash === item.hash && old.text === item.text ? old.uploadedAt || null : null
    };
  }

  // Giữ lại các file ready của cache cũ khi parser đổi audioText (ví dụ o ->
  // o.). Chúng không còn nằm trong kế hoạch mới, nhưng vẫn là fallback hợp lệ
  // cho phiên bản giao diện đang chạy trước khi cache mới được bổ sung.
  for (const old of Object.values(previous?.entries || {})) {
    if (old.status === 'ready' && old.hash && !entries[old.hash]) {
      const raw = normalizeText(old.text);
      // Không giữ lại cache legacy như "op" sau khi parser đã quy về "óp".
      // Nếu giữ chúng, manifest có hai key cho cùng một âm và runtime có thể
      // phát nhầm file cũ dù route/cache canonical đã đúng.
      if (raw && (isLegacyParserText(raw) || canonicalAudioText(raw) !== raw)) continue;
      entries[old.hash] = old;
    }
  }

  return {
    schemaVersion: 1,
    provider: 'fptcloud',
    apiUrl: API_URL,
    model: plan[0]?.model || MODEL,
    voice: plan[0]?.voice || VOICE,
    responseFormat: RESPONSE_FORMAT,
    generatedAt: previous?.generatedAt || null,
    entries
  };
}

async function validateCachedFile(entry) {
  if (!entry.file) return false;
  try {
    const filePath = path.join(OUTPUT_DIR, entry.file);
    const buffer = await fs.readFile(filePath);
    const normalized = normalizeWav(buffer);
    if (!normalized) return false;
    if (!buffer.equals(normalized)) await writeAtomic(filePath, normalized);
    entry.bytes = normalized.length;
    entry.trailingSilenceSeconds = TRAILING_SILENCE_SECONDS;
    return true;
  } catch {
    return false;
  }
}

async function requestAudio(text, timeoutMs, route = DEFAULT_ROUTE) {
  const apiKey = process.env.FPT_TTS_API_KEY;
  if (!apiKey) throw new Error('Thiếu biến môi trường FPT_TTS_API_KEY; chưa thực hiện request trả phí nào.');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({ model: route.model, input: text, response_format: RESPONSE_FORMAT, voice: route.voice }),
      signal: controller.signal
    });
    const body = Buffer.from(await response.arrayBuffer());
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${body.toString('utf8').slice(0, 300)}`);
    }
    const normalized = normalizeWav(body);
    if (!normalized) throw new Error('API trả về dữ liệu không phải WAV hợp lệ.');
    return normalized;
  } finally {
    clearTimeout(timeout);
  }
}

async function writeAtomic(filePath, buffer) {
  const tempPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(tempPath, buffer);
  try {
    await fs.rename(tempPath, filePath);
  } catch (error) {
    if (!['EPERM', 'EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error;
    await fs.rm(filePath, { force: true });
    await fs.rename(tempPath, filePath);
  } finally {
    await fs.rm(tempPath, { force: true }).catch(() => {});
  }
}

async function run() {
  const lockPath = path.join(OUTPUT_DIR, '.generate.lock');
  let lock;
  try {
    lock = await fs.open(lockPath, 'wx');
    await lock.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  } catch (error) {
    if (error.code === 'EEXIST') {
      throw new Error(`Đang có một tiến trình generate khác dùng ${OUTPUT_DIR}. Nếu tiến trình đã chết, kiểm tra rồi xoá ${lockPath}.`);
    }
    throw error;
  }

  try {
    await runUnlocked();
  } finally {
    await lock.close().catch(() => {});
    await fs.rm(lockPath, { force: true }).catch(() => {});
  }
}

async function runUnlocked() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('node tts-generate.js [--plan-only] [--repair-cache] [--retry-failed] [--retry-requested] [--text TEXT] [--model MODEL --voice VOICE] [--limit N] [--concurrency N] [--timeout MS]');
    return;
  }
  const catalog = await readCatalog();
  const routeConfig = await readRoutesConfig(catalog);
  let routeOverrides = {};
  if (args.model || args.voice) {
    if (!args.model || !args.voice || !args.text) {
      throw new Error('--model và --voice phải đi cùng --text khi tạo bản voice thêm nhanh.');
    }
    const route = normalizeRoute({ model: args.model, voice: args.voice }, catalog);
    if (!route) throw new Error(`Model/voice không có trong danh mục: ${args.model}/${args.voice}`);
    routeOverrides[args.text] = route;
  }
  const basePlan = args.text ? buildTextPlan(routeConfig) : [];
  let plan = buildTextPlan(routeConfig, routeOverrides);
  if (args.text) {
    const requestedRoute = routeOverrides[args.text] || getRouteForText(routeConfig, args.text);
    plan = ensureRequestedTextPlan(plan, args.text, requestedRoute);
  }
  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  const previous = await readManifest();
  const manifest = createManifest(plan, previous);
  await writeManifest(manifest);

  if (args.repairCache) {
    let repaired = 0;
    for (const entry of Object.values(manifest.entries)) {
      if (entry.status !== 'ready') continue;
      const filePath = path.join(OUTPUT_DIR, entry.file);
      const before = await fs.readFile(filePath).catch(() => null);
      if (!before) continue;
      const normalized = normalizeWav(before);
      if (normalized) {
        if (!before.equals(normalized)) {
          await writeAtomic(filePath, normalized);
          repaired++;
        }
        entry.bytes = normalized.length;
        entry.trailingSilenceSeconds = TRAILING_SILENCE_SECONDS;
      }
    }
    await writeManifest(manifest);
    console.log(`[TTS] Đã sửa header WAV cho ${repaired}/${Object.keys(manifest.entries).length} mục; không gọi API.`);
    return;
  }

  const entries = Object.values(manifest.entries);
  let missing = [];
  for (const entry of entries) {
    if (entry.status === 'ready' && await validateCachedFile(entry)) continue;
    if (entry.status === 'failed' && !args.retryFailed) continue;
    if (entry.status === 'requested' && !args.retryRequested) continue;
    missing.push(entry);
  }
  if (args.text) {
    const targetTexts = requestedTargetTexts(args.text, basePlan);
    missing = missing.filter(entry => targetTexts.has(entry.text));
  }

  const currentData = JSON.parse(fsSync.readFileSync(DATA_PATH, 'utf8'));
  console.log(`[TTS] data: ${currentData.length} nhóm, ${plan.length} câu duy nhất, cần tạo: ${missing.length}`);
  const customRouteCount = Object.keys(routeConfig.routes).length;
  console.log(`[TTS] route mặc định=${routeConfig.default.model}/${routeConfig.default.voice}, route riêng=${customRouteCount}, format=${RESPONSE_FORMAT}`);
  if (args.planOnly) {
    console.log('[TTS] plan-only: không gọi API trả phí.');
    return;
  }
  if (!missing.length) {
    console.log('[TTS] Cache đã đầy đủ, không gọi API.');
    return;
  }
  missing = missing.slice(0, args.limit);
  let cursor = 0;
  let completed = 0;
  async function worker() {
    while (true) {
      const entry = missing[cursor++];
      if (!entry) return;
      const started = Date.now();
      try {
        // Ghi trạng thái trước request. Nếu process chết sau khi FPT đã nhận
        // request nhưng trước khi client nhận response, lần chạy sau sẽ không
        // tự gọi lại và gây tính phí trùng.
        entry.status = 'requested';
        entry.requestedAt = new Date().toISOString();
        await writeManifest(manifest);
        const audio = await requestAudio(entry.text, args.timeoutMs, { model: entry.model, voice: entry.voice });
        await writeAtomic(path.join(OUTPUT_DIR, entry.file), audio);
        entry.status = 'ready';
        entry.bytes = audio.length;
        entry.trailingSilenceSeconds = TRAILING_SILENCE_SECONDS;
        entry.error = null;
        entry.requestedAt = null;
        completed++;
        await writeManifest(manifest);
        console.log(`[TTS] OK ${completed}/${missing.length} ${JSON.stringify(entry.text)} ${(Date.now() - started) / 1000}s`);
      } catch (error) {
        entry.status = 'failed';
        entry.error = error?.name === 'AbortError' ? 'timeout' : String(error.message || error);
        await writeManifest(manifest);
        console.error(`[TTS] FAILED ${JSON.stringify(entry.text)}: ${entry.error}`);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(args.concurrency, missing.length) }, worker));
  manifest.generatedAt = new Date().toISOString();
  await writeManifest(manifest);
  const ready = Object.values(manifest.entries).filter(entry => entry.status === 'ready').length;
  const failed = Object.values(manifest.entries).filter(entry => entry.status === 'failed').length;
  console.log(`[TTS] hoàn tất: ready=${ready}, failed=${failed}, còn planned=${entries.length - ready - failed}`);
  if (failed > 0) throw new Error(`Có ${failed} mục thất bại; cache chưa hoàn chỉnh.`);
}

if (require.main === module) {
  run().catch(error => {
    console.error('[TTS] Dừng:', error.message || error);
    process.exitCode = 1;
  });
}

module.exports = {
  buildTextPlan,
  ensureRequestedTextPlan,
  requestedTargetTexts,
  configFingerprint,
  isWav,
  normalizeText,
  normalizeWav,
  readRoutesConfig,
  readCatalog,
  createManifest
};
