'use strict';

/**
 * server.js — Backend cho "Bé Học Đánh Vần"
 * ---------------------------------------------------------------------------
 * Thay cho Web Speech API (window.speechSynthesis) trước đây, giờ giọng đọc
 * được tổng hợp bằng edge-tts-node (dùng giọng neural của Microsoft Edge) ở
 * phía server, trả về file MP3 cho trình duyệt phát. Lý do đổi cách làm này:
 *
 *  1. edge-tts-node là gói Node.js — KHÔNG chạy được trực tiếp trong trình
 *     duyệt, nên bắt buộc phải có 1 server nhỏ (file này) đứng giữa.
 *  2. Vì trình duyệt giờ phát file MP3 thật qua thẻ <audio> thay vì API đọc
 *     giọng hệ điều hành, việc chỉnh tốc độ đọc dùng `audio.playbackRate` —
 *     một thuộc tính rất ổn định của trình duyệt — thay vì
 *     `SpeechSynthesisUtterance.rate` (vốn hay bị một số giọng/hệ điều hành
 *     ÂM THẦM bỏ qua hoặc giới hạn lại, đúng như hiện tượng "kéo hết cỡ vẫn
 *     không đổi tốc độ" trước đây). Đây là nguyên nhân gốc của bug đó.
 *
 * CHẠY THỬ:
 *   npm install
 *   npm start
 *   → mở http://localhost:3000
 *
 * LƯU Ý QUAN TRỌNG VỀ edge-tts-node:
 *   Sandbox soạn code này KHÔNG có quyền truy cập npm registry (mọi request
 *   tới registry.npmjs.org đều bị chặn ở đây), nên phần gọi edge-tts-node bên
 *   dưới được viết theo API được tài liệu hoá phổ biến nhất của gói này
 *   (class `EdgeTTS`, phương thức `synthesize(text, voice, options)` rồi
 *   `toFile(path)`), nhưng KHÔNG THỂ tự chạy thử/xác nhận 100% khớp với bản
 *   bạn `npm install` về. Nếu sau khi cài đặt bạn gặp lỗi kiểu
 *   "tts.synthesize is not a function" hoặc "tts.toFile is not a function",
 *   hãy mở `node_modules/edge-tts-node/README.md` (hoặc trang npm của gói)
 *   để xem đúng tên hàm, rồi chỉnh lại đúng bên trong hàm `synthesizeToFile()`
 *   ngay dưới đây — đó là NƠI DUY NHẤT cần sửa nếu API khác đi.
 */

const path = require('path');
const fs = require('fs/promises');
const os = require('os');
const crypto = require('crypto');
const express = require('express');
const { EdgeTTS } = require('edge-tts-node');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = __dirname;
const CACHE_DIR = path.join(os.tmpdir(), 'be-hoc-danh-van-tts-cache');

// Giọng tiếng Việt neural có sẵn của Edge TTS. Có thể bổ sung thêm nếu
// Microsoft ra thêm giọng mới (danh sách đầy đủ: chạy `EdgeTTS`'s list voices
// nếu bản bạn cài có hỗ trợ, hoặc xem tài liệu Azure Neural TTS).
const VOICES = [
  { id: 'vi-VN-HoaiMyNeural', label: 'Hoài My (nữ)' },
  { id: 'vi-VN-NamMinhNeural', label: 'Nam Minh (nam)' }
];
const DEFAULT_VOICE = VOICES[0].id;
const VALID_VOICE_IDS = new Set(VOICES.map(v => v.id));

/**
 * Tổng hợp `text` bằng edge-tts-node và ghi ra file MP3 tại `outputPath`.
 * ĐÂY LÀ CHỖ DUY NHẤT CẦN CHỈNH nếu API thực tế của gói bạn cài khác với
 * những gì được giả định ở đây (xem ghi chú lớn ở đầu file).
 */
async function synthesizeToFile(text, voiceId, outputPath) {
  const tts = new EdgeTTS();
  // Luôn tổng hợp ở tốc độ/ngữ điệu trung tính — việc tăng/giảm tốc độ nghe
  // được xử lý ở TRÌNH DUYỆT (audio.playbackRate) để đổi tốc độ tức thời,
  // không cần gọi lại server mỗi lần kéo thanh trượt tốc độ.
  await tts.synthesize(text, voiceId, {
    rate: '+0%',
    pitch: '+0Hz',
    volume: '+0%'
  });
  await tts.toFile(outputPath);
}

async function ensureCacheDir() {
  await fs.mkdir(CACHE_DIR, { recursive: true });
}

function cacheKeyFor(text, voiceId) {
  return crypto.createHash('sha1').update(voiceId + '|' + text).digest('hex') + '.mp3';
}

const app = express();
app.use(express.json());

// Phục vụ luôn các file tĩnh của trang (index.html, script.js, style.css,
// phonics-parser.js, data.json) để không cần chạy 2 server song song và
// tránh vướng CORS khi gọi /api/tts.
app.use(express.static(PUBLIC_DIR));

app.get('/api/voices', (req, res) => {
  res.json({ voices: VOICES, defaultVoice: DEFAULT_VOICE });
});

app.post('/api/tts', async (req, res) => {
  try {
    const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
    if (!text) return res.status(400).json({ error: 'Thiếu "text" cần đọc.' });

    let voiceId = typeof req.body?.voice === 'string' ? req.body.voice : DEFAULT_VOICE;
    if (!VALID_VOICE_IDS.has(voiceId)) voiceId = DEFAULT_VOICE;

    await ensureCacheDir();
    const cachePath = path.join(CACHE_DIR, cacheKeyFor(text, voiceId));

    let audioBuffer;
    try {
      audioBuffer = await fs.readFile(cachePath);
    } catch {
      // Chưa có trong cache -> tổng hợp mới rồi lưu lại để lần sau phát nhanh,
      // không cần gọi Edge TTS lại cho đúng câu/từ đó nữa.
      await synthesizeToFile(text, voiceId, cachePath);
      audioBuffer = await fs.readFile(cachePath);
    }

    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.send(audioBuffer);
  } catch (err) {
    console.error('[TTS] Lỗi tổng hợp giọng đọc:', err);
    res.status(500).json({ error: 'Không tổng hợp được giọng đọc: ' + err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Bé Học Đánh Vần đang chạy tại http://localhost:${PORT}`);
});