(function () {
  'use strict';

  /* ======================================================================
     1. DỮ LIỆU
     Trước đây dữ liệu được dán trực tiếp ở đây. Giờ được tải từ file JSON
     ngoài (data.json, đặt cùng thư mục với index.html) qua fetch() ở mục 11
     bên dưới, để dễ chỉnh sửa/thay bộ từ mà không cần đụng vào code.
     Định dạng file data.json: [{ "key": "a", "values": ["a","à",...] }, ...]
     ====================================================================== */
  const DATA_URL = 'data.json';
  const STATIC_DEPLOY = /(^|\.)github\.io$/i.test(window.location.hostname);
  const PUBLIC_BASE_URL = new URL('.', document.baseURI).href;
  document.documentElement.classList.toggle('static-deploy', STATIC_DEPLOY);

  function publicUrl(path) {
    return new URL(path, PUBLIC_BASE_URL).href;
  }

  let DATA = null;
  let keyCarouselInstance = null;
  let suppressCarouselMove = false;
  const audioElementCache = new Map();
  let presentationWakeLock = null;

  /* ======================================================================
     2. LÀM PHẲNG DỮ LIỆU
     (chuyển thành hàm vì giờ chỉ chạy được SAU KHI tải xong data.json —
     xem hàm flattenData() và init() ở mục 11)
     ====================================================================== */
  let KEYS = [];
  let FLAT = [];
  let KEY_FIRST_FLAT_INDEX = {};

  function flattenData(data) {
    const groups = Array.isArray(data)
      ? data.map(group => ({ key: String(group.key), words: group.values }))
      : Object.entries(data).map(([key, words]) => ({ key, words }));
    const keys = groups.map(group => group.key);
    const flat = [];
    groups.forEach(({ key, words }, keyIndex) => {
      if (!Array.isArray(words)) throw new Error(`Nhóm "${key}" không có values là mảng.`);
      words.forEach((word, wordIndexInKey) => {
        flat.push({
          key, word, keyIndex,
          totalKeys: keys.length,
          wordIndexInKey,
          totalWordsInKey: words.length
        });
      });
    });
    const firstIndex = {};
    flat.forEach((item, i) => {
      if (!(item.key in firstIndex)) firstIndex[item.key] = i;
    });
    return { keys, flat, firstIndex };
  }

  /* ======================================================================
     3. STATE
     ====================================================================== */
  const state = {
    flatIndex: 0,
    rate: 1.5,
    transitionDelay: 0.3,
    speedMode: 'normal',
    voice: 'std_leminh',
    spellingMode: 'full',
    playToken: 0,
    autoPlay: false,
    autoTimer: null,
    isReading: false,
    started: false
  };
  const LETTERS_ONLY_MODE = 'letters-only';
  const PLAYBACK_SETTINGS_KEY = 'be-hoc-danh-van.playback-settings.v1';
  const SPEED_PRESETS = Object.freeze({
    slow: { label: 'Chậm', rate: 0.8, transition: 0.5 },
    medium: { label: 'Trung bình', rate: 1.1, transition: 0.4 },
    normal: { label: 'Bình thường', rate: 1.5, transition: 0.3 },
    fast: { label: 'Bình nhanh', rate: 1.9, transition: 0.1 }
  });

  function updateSpeedModeUI() {
    if (el.speedModeStatus) {
      const label = SPEED_PRESETS[state.speedMode]?.label || 'Tự chỉnh';
      el.speedModeStatus.textContent = `Trạng thái: ${label}`;
    }
    el.speedPresets?.forEach(button => {
      button.classList.toggle('is-active', button.dataset.speedMode === state.speedMode);
      button.setAttribute('aria-pressed', String(button.dataset.speedMode === state.speedMode));
    });
  }

  function persistPlaybackSettings() {
    try {
      localStorage.setItem(PLAYBACK_SETTINGS_KEY, JSON.stringify({
        rate: state.rate,
        transition: state.transitionDelay,
        speedMode: state.speedMode
      }));
    } catch (_) {
      // Một số chế độ riêng tư có thể chặn localStorage; khi đó vẫn dùng được
      // trong phiên hiện tại mà không làm gián đoạn việc đọc.
    }
  }

  function setSpeedMode(mode, { persist = true } = {}) {
    const preset = SPEED_PRESETS[mode];
    if (!preset) return;
    state.speedMode = mode;
    state.rate = preset.rate;
    state.transitionDelay = preset.transition;
    if (el.rateSlider) el.rateSlider.value = String(preset.rate);
    if (el.rateValue) el.rateValue.textContent = `${preset.rate.toFixed(1)}×`;
    if (el.transitionSlider) el.transitionSlider.value = String(preset.transition);
    if (el.transitionValue) el.transitionValue.textContent = `${preset.transition.toFixed(1)}s`;
    updateSpeedModeUI();
    if (persist) persistPlaybackSettings();
  }

  function loadPlaybackSettings() {
    let stored = null;
    try { stored = JSON.parse(localStorage.getItem(PLAYBACK_SETTINGS_KEY) || 'null'); } catch (_) {}
    if (stored && Number.isFinite(Number(stored.rate)) && Number.isFinite(Number(stored.transition))) {
      state.rate = Math.max(0.5, Math.min(3, Number(stored.rate)));
      state.transitionDelay = Math.max(0, Math.min(2, Number(stored.transition)));
      state.speedMode = SPEED_PRESETS[stored.speedMode] ? stored.speedMode : 'custom';
      if (el.rateSlider) el.rateSlider.value = String(state.rate);
      if (el.rateValue) el.rateValue.textContent = `${state.rate.toFixed(1)}×`;
      if (el.transitionSlider) el.transitionSlider.value = String(state.transitionDelay);
      if (el.transitionValue) el.transitionValue.textContent = `${state.transitionDelay.toFixed(1)}s`;
      updateSpeedModeUI();
    } else {
      setSpeedMode('normal', { persist: false });
    }
  }

  /* ======================================================================
     4. DOM
     ====================================================================== */
  const el = {
    letter: document.getElementById('letterDisplay'),
    keyCarousel: document.getElementById('keyCarousel'),
    keyCarouselTrack: document.getElementById('keyCarouselTrack'),
    wholeWordCaption: document.getElementById('wholeWordCaption'),
    onsetCell: document.getElementById('onsetCell'),
    onsetText: document.getElementById('onsetText'),
    rimeCell: document.getElementById('rimeCell'),
    rimeText: document.getElementById('rimeText'),
    mergeCell: document.getElementById('mergeCell'),
    mergeText: document.getElementById('mergeText'),
    stage: document.getElementById('stage'),
    readingView: document.getElementById('readingView'),
    homePanel: document.getElementById('homePanel'),
    startBtn: document.getElementById('startBtn'),
    homeSettingsBtn: document.getElementById('homeSettingsBtn'),
    exitBtn: document.getElementById('exitBtn'),
    exitDialog: document.getElementById('exitDialog'),
    exitStayBtn: document.getElementById('exitStayBtn'),
    exitConfirmBtn: document.getElementById('exitConfirmBtn'),
    replayBtn: document.getElementById('replayBtn'),
    prevKeyBtn: document.getElementById('prevKeyBtn'),
    nextKeyBtn: document.getElementById('nextKeyBtn'),
    prevKeyLabel: document.getElementById('prevKeyLabel'),
    nextKeyLabel: document.getElementById('nextKeyLabel'),
    keyPos: document.getElementById('keyPos'),
    keyTotal: document.getElementById('keyTotal'),
    wordPos: document.getElementById('wordPos'),
    rateSlider: document.getElementById('rateSlider'),
    rateValue: document.getElementById('rateValue'),
    transitionSlider: document.getElementById('transitionSlider'),
    transitionValue: document.getElementById('transitionValue'),
    controls: document.getElementById('controls'),
    controlsToggle: document.getElementById('controlsToggle'),
    controlsPanel: document.getElementById('controlsPanel'),
    speedPresets: Array.from(document.querySelectorAll('[data-speed-mode]')),
    speedModeStatus: document.getElementById('speedModeStatus'),
    mainPrevBtn: document.getElementById('mainPrevBtn'),
    mainNextBtn: document.getElementById('mainNextBtn'),
    autoPlayToggle: document.getElementById('autoPlayToggle'),
    voiceSelect: document.getElementById('voiceSelect'),
    readingModeSelect: document.getElementById('readingModeSelect'),
    cacheSearch: document.getElementById('cacheSearch'),
    cacheList: document.getElementById('cacheList'),
    cacheSummary: document.getElementById('cacheSummary'),
    cacheStatus: document.getElementById('cacheStatus'),
    cacheSave: document.getElementById('cacheSave'),
    cacheRefresh: document.getElementById('cacheRefresh'),
    settingsBtn: document.getElementById('settingsBtn'),
    settingsPanel: document.getElementById('settingsPanel'),
    settingsClose: document.getElementById('settingsClose'),
    ttsToken: document.getElementById('ttsToken'),
    generateRouteSelect: document.getElementById('generateRouteSelect'),
    generateMissingBtn: document.getElementById('generateMissingBtn'),
    generateStatus: document.getElementById('generateStatus'),
    catalogModel: document.getElementById('catalogModel'),
    catalogVoice: document.getElementById('catalogVoice'),
    catalogLabel: document.getElementById('catalogLabel'),
    catalogAddBtn: document.getElementById('catalogAddBtn'),
    catalogList: document.getElementById('catalogList'),
    catalogSummary: document.getElementById('catalogSummary'),
    prefixRoutePrefix: document.getElementById('prefixRoutePrefix'),
    prefixRouteSelect: document.getElementById('prefixRouteSelect'),
    prefixToneExclusions: document.getElementById('prefixToneExclusions'),
    prefixRouteAdd: document.getElementById('prefixRouteAdd'),
    prefixRouteList: document.getElementById('prefixRouteList')
  };

  /* ======================================================================
     5. TIỆN ÍCH: TÁCH ÂM ĐẦU / VẦN ĐỂ HIỂN THỊ 2 Ô VUÔNG
     (độc lập với logic đánh vần bên trong engine — chỉ phục vụ UI)
     ====================================================================== */
  const VOWELS = new Set(['a','ă','â','e','ê','i','o','ô','ơ','u','ư','y']);
  const ONSET_ORDER_DISPLAY = [
    'ngh','ng','nh','ch','tr','th','ph','kh','gh','gi',
    'b','c','d','đ','g','h','k','l','m','n','p','q','r','s','t','v','x'
  ];

  function tonelessOf(str) {
    return window.PhonicsParser.stripTone(str).base;
  }

  function rimeForDisplay(str) {
    // Ô phần cuối dùng mặt chữ không dấu. Dấu chỉ xuất hiện ở ô từ hoàn
    // chỉnh tại bước tone, để màu đỏ tập trung đúng vào nguyên âm mang dấu.
    return tonelessOf(str);
  }

  function splitForDisplay(word) {
    const toneless = tonelessOf(word).toLowerCase();
    const chars = Array.from(word);

    if (toneless.startsWith('gi')) {
      const remaining = toneless.slice(2);
      if (remaining === '') {
        // "gi" đứng một mình (gì, gí...) — không có vần riêng để tách.
        return { onset: chars.join(''), rime: '' };
      }
      const firstCh = remaining.charAt(0);
      const isConsonantStart = !VOWELS.has(firstCh);
      const needsRestore = isConsonantStart || firstCh === 'ê';
      const onsetLen = needsRestore ? 1 : 2; // hidden-i case: onset chỉ là "g"
      return {
        onset: chars.slice(0, onsetLen).join(''),
        rime: rimeForDisplay(chars.slice(onsetLen).join(''))
      };
    }

    // Với "qu", cách chia phần đầu/phần cuối phụ thuộc vào độ dài phần sau
    // "qu": qua/quê/quy là qu + a/ê/y, còn quay/quan/quýt là q + uay/uan/uýt.
    // Nếu dùng ONSET_ORDER_DISPLAY thuần túy, mọi từ bắt đầu bằng "qu" đều bị
    // chia thành q + ua..., làm ô "Phần đầu" hiển thị sai ở các vần đơn.
    if (toneless.startsWith('qu')) {
      const afterQu = chars.slice(2);
      if (afterQu.length <= 1) {
        return {
          onset: chars.slice(0, 2).join(''),
          rime: rimeForDisplay(afterQu.join(''))
        };
      }
      return {
        onset: chars.slice(0, 1).join(''),
        rime: rimeForDisplay(chars.slice(1).join(''))
      };
    }

    let onsetLen = 0;
    for (const pat of ONSET_ORDER_DISPLAY) {
      if (toneless.startsWith(pat)) { onsetLen = pat.length; break; }
    }
    return {
      onset: chars.slice(0, onsetLen).join(''),
      rime: rimeForDisplay(chars.slice(onsetLen).join(''))
    };
  }

  const ONSET_SPOKEN_NAMES = {
    ngh: 'ngờ', ng: 'ngờ', nh: 'nhờ', ch: 'chờ', tr: 'trờ', th: 'thờ',
    ph: 'phờ', kh: 'khờ', gh: 'gờ', b: 'bờ', c: 'cờ', d: 'dờ', đ: 'đờ',
    g: 'gờ', h: 'hờ', k: 'ca', l: 'lờ', m: 'mờ', n: 'nờ', p: 'pờ',
    q: 'cùa', qu: 'cùa', r: 'rờ', s: 'sờ', t: 'tờ', v: 'vờ', x: 'xờ', gi: 'gi'
  };

  const FINAL_SPOKEN_NAMES = {
    ng: 'ngờ', nh: 'nhờ', ch: 'chờ', c: 'cờ', m: 'mờ', n: 'nờ', p: 'pờ', t: 'tờ'
  };

  const FACE_AUDIO_OVERRIDES = {
    o: 'o.', ô: 'ô.', ư: 'ư.',
    'sờ': 'Sờ.', 'xờ': 'Xờ.'
  };

  function faceStep(type, text) {
    const audioText = FACE_AUDIO_OVERRIDES[text];
    return audioText ? { type, text, audioText } : { type, text };
  }

  function faceLetterName(ch) {
    return { ă: 'á', â: 'ớ' }[ch] || ch;
  }

  // Chế độ này chỉ lấy phụ âm đầu + từng chữ trong vần. Không lấy combine,
  // tone hoặc final của từ hoàn chỉnh nên không phát âm dấu và không đọc thành
  // tiếng hoàn chỉnh. Các bước vẫn được đưa qua speak() bằng đúng cache/giọng
  // LeminH; dùng chữ thật (y, không đổi thành i) vì đây là chế độ nhìn mặt chữ.
  function buildFaceLetterSteps(word) {
    const { onset, rime } = splitForDisplay(word);
    const steps = [];
    if (onset) {
      const onsetKey = tonelessOf(onset).toLowerCase();
      steps.push(faceStep('token', ONSET_SPOKEN_NAMES[onsetKey] || onset));
    }

    const rimePlain = tonelessOf(rime).toLowerCase();
    const { nucleus, final } = window.PhonicsParser.splitNucleusFinal(rimePlain);
    Array.from(nucleus).forEach(ch => steps.push(faceStep('letter', faceLetterName(ch))));
    if (final) steps.push(faceStep('token', FINAL_SPOKEN_NAMES[final] || final));
    return steps;
  }

  /* ======================================================================
     6. TIỆN ÍCH DOM: chữ cái từng ô, highlight
     ====================================================================== */
  function setCellChars(container, text) {
    container.innerHTML = '';
    Array.from(text).forEach(ch => {
      const span = document.createElement('span');
      span.className = 'ch';
      span.textContent = ch;
      container.appendChild(span);
    });
  }

  function clearLit(container) {
    container.querySelectorAll('.ch').forEach(s => {
      s.classList.remove('lit', 'lit-out', 'tone-pulse');
    });
  }

  function activateLit(span) {
    if (!span) return;
    if (span.classList.contains('lit-out')) {
      span.classList.remove('lit', 'lit-out');
      void span.offsetWidth;
    }
    span.classList.add('lit');
  }

  function litAll(container) {
    container.querySelectorAll('.ch').forEach(activateLit);
  }

  function litRange(container, from, to) {
    const spans = container.querySelectorAll('.ch');
    for (let i = from; i <= to; i++) {
      if (spans[i]) activateLit(spans[i]);
    }
  }

  function litOnly(container, index) {
    clearLit(container);
    const span = container.querySelectorAll('.ch')[index];
    activateLit(span);
  }

  function fadeLit(container) {
    container.querySelectorAll('.ch.lit').forEach(span => {
      span.classList.add('lit-out');
      setTimeout(() => {
        if (span.classList.contains('lit-out')) {
          span.classList.remove('lit', 'lit-out', 'tone-pulse');
        }
      }, 360);
    });
  }

  /* ======================================================================
     7. GIỌNG ĐỌC — file WAV đã generate từ FPT.AI-VITs
     ---------------------------------------------------------------------
     Trình duyệt tuyệt đối không gọi API trả phí. Mỗi text được tìm trong
     audio-cache/manifest.json và phát file WAV đã generate sẵn. Tốc độ đọc
     dùng playbackRate; chỉ cần generate một bản trung tính cho mỗi text.
     ====================================================================== */
  let activeSpeechCancel = null;
  let currentAudio = null;
  let audioEntriesByText = new Map();
  let audioRoutes = { default: { model: 'FPT.AI-VITs', voice: 'std_leminh' }, routes: {} };
  let audioManifest = null;
  let cacheCatalog = [];
  let pendingCacheRoutes = {};
  let pendingPrefixRoutes = {};
  let cacheRoutesDirty = false;
  let cacheStatusData = null;
  let cacheRefreshTimer = null;
  let audioManifestError = null;

  function normalizeAudioText(text) {
    return String(text || '').normalize('NFC').trim().replace(/\s+/g, ' ');
  }

  function canonicalAudioText(text) {
    const normalized = normalizeAudioText(text);
    return window.PhonicsParser.canonicalAudioText
      ? window.PhonicsParser.canonicalAudioText(normalized)
      : ({ o: 'o.', 'ô': 'ô.', 'ư': 'ư.' })[normalized] || normalized;
  }

  const PREFIX_TONES = [
    { index: 1, label: 'huyền' }, { index: 2, label: 'sắc' },
    { index: 3, label: 'hỏi' }, { index: 4, label: 'ngã' },
    { index: 5, label: 'nặng' }
  ];

  function prefixRouteForText(text, prefixRoutes = {}) {
    const parser = window.PhonicsParser;
    const normalized = normalizeAudioText(text);
    const prefix = normalizeAudioText(parser.splitOnsetRime(normalized).onset).toLowerCase();
    const rule = prefixRoutes?.[prefix];
    if (!rule) return null;
    const toneIndex = parser.stripTone(normalized).toneIndex;
    return rule.excludeTones?.includes(toneIndex) ? null : rule;
  }

  function routeForCache(text, config = audioRoutes) {
    const normalized = canonicalAudioText(text);
    return config?.routes?.[normalized] ||
      prefixRouteForText(normalized, config?.prefixRoutes || {}) ||
      config?.default || audioRoutes.default;
  }

  function audioCacheVersion(entry, manifest = audioManifest) {
    return encodeURIComponent(entry?.uploadedAt || entry?.generatedAt || manifest?.generatedAt || entry?.bytes || 'current');
  }

  function setAudioManifest(manifest, routeConfig = audioRoutes) {
    audioManifest = manifest;
    audioEntriesByText = new Map();
    for (const entry of Object.values(manifest?.entries || {})) {
      if (entry.status === 'ready' && entry.text && entry.file) {
        const text = canonicalAudioText(entry.text);
        const entries = audioEntriesByText.get(text) || [];
        entries.push({
          ...entry,
          // File upload có thể thay WAV nhưng vẫn giữ nguyên hash/tên file.
          // Query version buộc browser bỏ audio cũ đang immutable-cache.
          url: STATIC_DEPLOY
            ? publicUrl('audio-cache/' + encodeURIComponent(entry.file)) + `?v=${audioCacheVersion(entry, manifest)}`
            : '/audio/' + encodeURIComponent(entry.file) + `?v=${audioCacheVersion(entry, manifest)}`
        });
        audioEntriesByText.set(text, entries);
      }
    }
    applyRuntimeConfig(routeConfig);
  }

  function cachedAudioElement(url) {
    let audio = audioElementCache.get(url);
    if (audio) return audio;
    audio = new Audio();
    audio.preload = 'auto';
    audio.src = url;
    audio.load();
    audioElementCache.set(url, audio);
    while (audioElementCache.size > 32) {
      const oldest = audioElementCache.keys().next().value;
      const candidate = audioElementCache.get(oldest);
      if (candidate === currentAudio) break;
      candidate?.pause();
      audioElementCache.delete(oldest);
    }
    return audio;
  }

  function warmAudioForItem(item) {
    if (!item || !audioManifest) return;
    const texts = new Set([item.word]);
    const steps = state.spellingMode === LETTERS_ONLY_MODE
      ? buildFaceLetterSteps(item.word)
      : window.PhonicsParser.buildSpellingSteps(item.word).steps;
    steps.forEach(step => { if (step?.text) texts.add(step.text); });
    texts.forEach(text => {
      const entry = selectAudioEntry(text, item.word);
      if (entry) cachedAudioElement(entry.url);
    });
  }

  function applyRuntimeConfig(routeConfig) {
    const unsavedRoutes = pendingCacheRoutes;
    const unsavedPrefixRoutes = pendingPrefixRoutes;
    audioRoutes = routeConfig || audioRoutes;
    cacheCatalog = Array.isArray(routeConfig?.catalog) ? routeConfig.catalog : cacheCatalog;
    // Polling manifest/settings được phép cập nhật cache và catalog, nhưng
    // tuyệt đối không ghi đè lựa chọn người dùng đang chưa bấm Lưu route.
    pendingCacheRoutes = cacheRoutesDirty
      ? unsavedRoutes
      : { ...(audioRoutes.routes || {}) };
    pendingPrefixRoutes = cacheRoutesDirty
      ? unsavedPrefixRoutes
      : { ...(audioRoutes.prefixRoutes || {}) };
    populateVoiceSelect();
  }

  function routeMatches(entry, route) {
    return !!route && entry.model === route.model && entry.voice === route.voice;
  }

  function selectedVoiceRoute() {
    const selected = cacheCatalog.find(item => (item.voice || item.id) === state.voice);
    return selected
      ? { model: selected.model, voice: selected.voice || selected.id }
      : audioRoutes.default;
  }

  function selectAudioEntry(text, word = '') {
    const normalized = canonicalAudioText(text);
    const entries = audioEntriesByText.get(normalized) || [];
    const activeRoutes = cacheRoutesDirty ? pendingCacheRoutes : (audioRoutes.routes || {});
    const activePrefixRoutes = cacheRoutesDirty ? pendingPrefixRoutes : (audioRoutes.prefixRoutes || {});
    const route = activeRoutes[normalized] || prefixRouteForText(normalized, activePrefixRoutes) || selectedVoiceRoute();
    return entries.find(entry => routeMatches(entry, route)) || entries[0] || null;
  }

  function routeValue(route) {
    return route ? `${route.model}::${route.voice}` : '';
  }

  function routeFromValue(value) {
    const [model, voice] = String(value || '').split('::');
    return model && voice ? { model, voice } : null;
  }

  function populateVoiceSelect() {
    if (!el.voiceSelect || !cacheCatalog.length) return;
    const selected = state.voice;
    el.voiceSelect.replaceChildren();
    for (const voice of cacheCatalog) {
      const option = document.createElement('option');
      option.value = voice.voice || voice.id;
      option.textContent = voice.label || `${voice.model} · ${voice.voice || voice.id}`;
      el.voiceSelect.appendChild(option);
    }
    const available = [...el.voiceSelect.options].some(option => option.value === selected);
    el.voiceSelect.value = available ? selected : (cacheCatalog[0].voice || cacheCatalog[0].id);
    state.voice = el.voiceSelect.value;
  }

  function cacheRouteFor(text) {
    const normalized = canonicalAudioText(text);
    const prefixRoutes = cacheRoutesDirty ? pendingPrefixRoutes : (audioRoutes.prefixRoutes || {});
    return pendingCacheRoutes[normalized] || prefixRouteForText(normalized, prefixRoutes) || audioRoutes.default;
  }

  function cacheStatusText(entries) {
    const ready = entries.filter(entry => entry.status === 'ready').length;
    const failed = entries.filter(entry => entry.status === 'failed').length;
    const planned = entries.length - ready - failed;
    const parts = [];
    if (ready) parts.push(`sẵn sàng ${ready}`);
    if (planned) parts.push(`chưa có ${planned}`);
    if (failed) parts.push(`lỗi ${failed}`);
    return parts.join(' · ') || 'chưa có file';
  }

  function renderCacheManager() {
    if (!el.cacheList || !audioManifest) return;
    const grouped = new Map();
    for (const entry of Object.values(audioManifest.entries || {})) {
      const text = canonicalAudioText(entry.text);
      if (!text) continue;
      const list = grouped.get(text) || [];
      list.push(entry);
      grouped.set(text, list);
    }
    // data.json có thể vừa được sửa mà chưa chạy plan/generate; vẫn hiển thị
    // ngay các text mới đang thiếu do server vừa quét thấy.
    for (const item of cacheStatusData?.items || []) {
      const text = canonicalAudioText(item.text);
      if (!text) continue;
      const list = grouped.get(text) || [];
      for (const variant of item.variants || []) {
        if (!list.some(entry => entry.hash === variant.hash)) list.push(variant);
      }
      grouped.set(text, list);
    }
    const query = normalizeAudioText(el.cacheSearch?.value || '').toLowerCase();
    const all = [...grouped.entries()].sort((a, b) => a[0].localeCompare(b[0], 'vi'));
    const statusByText = new Map((cacheStatusData?.items || []).map(item => [canonicalAudioText(item.text), item]));
    const filtered = all
      .filter(([text]) => text.toLowerCase().includes(query))
      .sort(([textA], [textB]) => {
        if (!query) return textA.localeCompare(textB, 'vi');
        const normalizedA = textA.toLowerCase();
        const normalizedB = textB.toLowerCase();
        const exactA = normalizedA === query || normalizedA.replace(/[.!?]+$/, '') === query;
        const exactB = normalizedB === query || normalizedB.replace(/[.!?]+$/, '') === query;
        if (exactA !== exactB) return exactA ? -1 : 1;
        const prefixA = normalizedA.startsWith(query);
        const prefixB = normalizedB.startsWith(query);
        if (prefixA !== prefixB) return prefixA ? -1 : 1;
        if (textA.length !== textB.length) return textA.length - textB.length;
        return textA.localeCompare(textB, 'vi');
      });
    el.cacheList.replaceChildren();
    for (const [text, manifestEntries] of filtered) {
      const statusItem = statusByText.get(text);
      const entries = statusItem?.variants?.length ? statusItem.variants : manifestEntries;
      const row = document.createElement('div');
      row.className = 'cache-row';

      const main = document.createElement('div');
      main.className = 'cache-row-main';
      const textNode = document.createElement('span');
      textNode.className = 'cache-text';
      textNode.textContent = text;
      const meta = document.createElement('span');
      meta.className = 'cache-meta';
      const statusLabel = statusItem
        ? `${statusItem.status === 'ready' ? 'sẵn sàng' : 'THIẾU CACHE'} · dùng ${statusItem.uses} lần · ${entries.length} bản`
        : cacheStatusText(entries);
      const serverRoute = routeForCache(text, audioRoutes);
      const hasUnsavedRoute = cacheRoutesDirty && routeValue(cacheRouteFor(text)) !== routeValue(serverRoute);
      meta.textContent = statusLabel + (hasUnsavedRoute ? ' · route mới chưa lưu' : '');
      main.append(textNode, meta);

      const select = document.createElement('select');
      select.className = 'cache-route-select';
      select.dataset.cacheText = text;
      const currentRoute = cacheRouteFor(text);
      for (const voice of cacheCatalog) {
        const option = document.createElement('option');
        const route = { model: voice.model, voice: voice.voice || voice.id };
        option.value = routeValue(route);
        option.textContent = voice.label || `${route.model} · ${route.voice}`;
        option.selected = routeValue(currentRoute) === option.value;
        select.appendChild(option);
      }
      select.addEventListener('change', () => {
        const route = routeFromValue(select.value);
        if (!route) return;
        const routeText = canonicalAudioText(text);
        const inheritedRoute = prefixRouteForText(routeText, pendingPrefixRoutes);
        if (routeValue(route) === routeValue(inheritedRoute) ||
            (!inheritedRoute && routeValue(route) === routeValue(audioRoutes.default))) {
          delete pendingCacheRoutes[routeText];
        } else {
          pendingCacheRoutes[routeText] = route;
        }
        cacheRoutesDirty = true;
        meta.textContent = `${cacheStatusText(entries)} · route mới chưa lưu`;
        if (el.cacheStatus) el.cacheStatus.textContent = 'Có thay đổi route chưa lưu; chưa gọi API.';
      });
      const quickButton = document.createElement('button');
      quickButton.type = 'button';
      quickButton.className = 'cache-action cache-quick-btn';
      quickButton.textContent = 'Thêm nhanh';
      quickButton.title = 'Tạo thêm một bản voice cho riêng cache này, không đổi route đang dùng';
      quickButton.addEventListener('click', () => quickGenerateCache(text, routeFromValue(select.value), quickButton));
      const variants = document.createElement('div');
      variants.className = 'cache-variants';
      for (const entry of entries) {
        const variant = document.createElement('div');
        variant.className = 'cache-variant';
        const variantText = document.createElement('span');
        variantText.textContent = `${entry.model || 'FPT.AI-VITs'} · ${entry.voice || 'std_leminh'} · ${entry.status || 'planned'}`;
        if (entry.status === 'ready' && entry.file) {
          const previewButton = document.createElement('button');
          previewButton.type = 'button';
          previewButton.className = 'cache-preview-btn';
          previewButton.textContent = '▶';
          previewButton.title = `Nghe thử ${entry.voice || ''}`;
          previewButton.setAttribute('aria-label', `Nghe thử ${entry.voice || entry.model || 'cache'}`);
          previewButton.addEventListener('click', () => previewCache(entry));
          variant.prepend(previewButton);
        }
        const actions = document.createElement('span');
        actions.className = 'cache-variant-actions';
        if (entry.status === 'ready' && entry.file && entry.hash) {
          const downloadButton = document.createElement('a');
          downloadButton.className = 'cache-download-btn';
          downloadButton.textContent = 'Tải';
          downloadButton.title = `Tải audio ${entry.voice || ''}`;
          downloadButton.href = `/api/cache/${encodeURIComponent(entry.hash)}/download`;
          downloadButton.setAttribute('download', '');
          actions.appendChild(downloadButton);
        }
        if (entry.hash && entry.model && entry.voice) {
          const uploadButton = document.createElement('button');
          uploadButton.type = 'button';
          uploadButton.className = 'cache-upload-btn';
          uploadButton.textContent = 'Nạp';
          uploadButton.title = `Nạp WAV cho ${entry.model} · ${entry.voice}`;
          const fileInput = document.createElement('input');
          fileInput.type = 'file';
          fileInput.accept = '.wav,audio/wav,audio/x-wav';
          fileInput.className = 'cache-upload-input';
          uploadButton.addEventListener('click', () => fileInput.click());
          fileInput.addEventListener('change', async () => {
            const file = fileInput.files?.[0];
            fileInput.value = '';
            if (file) await uploadCache(entry, text, file, uploadButton);
          });
          actions.append(uploadButton, fileInput);
        }
        const deleteButton = document.createElement('button');
        deleteButton.type = 'button';
        deleteButton.className = 'cache-delete-btn';
        deleteButton.textContent = 'Xoá';
        deleteButton.disabled = !entry.hash || entry.status !== 'ready';
        deleteButton.addEventListener('click', () => deleteCache(entry.hash, text));
        actions.appendChild(deleteButton);
        variant.append(variantText, actions);
        variants.appendChild(variant);
      }
      row.append(main, select, quickButton, variants);
      el.cacheList.appendChild(row);
    }
    if (el.cacheSummary) {
      el.cacheSummary.textContent = cacheStatusData
        ? `${cacheStatusData.missing} thiếu · ${cacheStatusData.ready}/${cacheStatusData.total} sẵn sàng · đang xem ${filtered.length}/${all.length}`
        : `${filtered.length}/${all.length} cache`;
    }
  }

  function isCacheManagerInteracting() {
    const active = document.activeElement;
    if (!active) return false;
    if (el.cacheList?.contains(active)) return true;
    if (el.settingsPanel?.contains(active) && active.matches('input, select, textarea, button')) return true;
    return false;
  }

  async function fetchAudioManifest() {
    if (STATIC_DEPLOY) return fetch(publicUrl('audio-cache/manifest.json'), { cache: 'no-store' });
    const response = await fetch('/api/manifest', { cache: 'no-store' });
    // Cho phép trang vẫn dùng được nếu browser còn kết nối server cũ chưa
    // restart trong lúc cập nhật code. Sau khi restart, luôn đi endpoint an toàn.
    if (response.status !== 404) return response;
    return fetch('/audio/manifest.json', { cache: 'no-store' });
  }

  async function refreshCacheManager({ quiet = false, force = false } = {}) {
    if (STATIC_DEPLOY) return;
    try {
      const [manifestRes, routesRes, statusRes] = await Promise.all([
        fetchAudioManifest(),
        fetch('/api/cache-routes', { cache: 'no-store' }),
        fetch('/api/settings', { cache: 'no-store' })
      ]);
      if (!manifestRes.ok || !routesRes.ok || !statusRes.ok) throw new Error('Không tải được danh sách cache hoặc route.');
      const manifest = await manifestRes.json();
      const routeConfig = await routesRes.json();
      cacheStatusData = await statusRes.json();
      setAudioManifest(manifest, routeConfig);
      // Polling không được huỷ select đang mở, nút đang bấm hoặc input người dùng
      // đang nhập. Nếu replaceChildren() lúc này, trình duyệt sẽ mất focus và
      // route vừa chọn cho "Thêm nhanh" có thể bị gửi nhầm route cũ.
      if (force || !isCacheManagerInteracting()) {
        renderCatalogManager();
        renderCacheManager();
      }
      if (!quiet && el.cacheStatus) el.cacheStatus.textContent = 'Đã quét lại data.json và manifest hiện tại.';
    } catch (error) {
      if (!quiet && el.cacheStatus) el.cacheStatus.textContent = error.message || 'Không làm mới được cache.';
    }
  }

  async function uploadCache(entry, text, file, button) {
    if (file.size > 20 * 1024 * 1024) {
      if (el.cacheStatus) el.cacheStatus.textContent = 'File WAV quá lớn; giới hạn là 20 MB.';
      return;
    }
    button.disabled = true;
    try {
      const params = new URLSearchParams({
        text,
        model: entry.model,
        voice: entry.voice
      });
      const response = await fetch(`/api/cache/upload?${params.toString()}`, {
        method: 'POST',
        headers: { 'Content-Type': file.type || 'audio/wav' },
        body: file
      });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.error || 'Không nạp được audio cache.');
      await refreshCacheManager({ quiet: true, force: true });
      if (el.cacheStatus) el.cacheStatus.textContent = `Đã nạp audio "${text}" · ${entry.voice}; không gọi API TTS.`;
    } catch (error) {
      if (el.cacheStatus) el.cacheStatus.textContent = error.message || 'Không nạp được audio cache.';
    } finally {
      button.disabled = false;
    }
  }

  async function deleteCache(hash, text) {
    if (!hash || !confirm(`Xoá cache của "${text}"? Nếu còn bản khác, ứng dụng sẽ fallback sang bản đó.`)) return;
    try {
      const res = await fetch(`/api/cache/${encodeURIComponent(hash)}`, { method: 'DELETE' });
      const result = await res.json();
      if (!res.ok || !result.ok) throw new Error(result.error || 'Không xoá được cache.');
      await refreshCacheManager({ quiet: true, force: true });
      if (el.cacheStatus) el.cacheStatus.textContent = `Đã xoá cache "${text}"; hệ thống đã cập nhật trạng thái thiếu.`;
    } catch (error) {
      if (el.cacheStatus) el.cacheStatus.textContent = error.message || 'Không xoá được cache.';
    }
  }

  async function saveCacheRoutes({ autoGenerate = false } = {}) {
    if (!el.cacheSave) return;
    el.cacheSave.disabled = true;
    try {
      const res = await fetch('/api/cache-routes', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          default: audioRoutes.default,
          routes: pendingCacheRoutes,
          prefixRoutes: pendingPrefixRoutes
        })
      });
      const result = await res.json();
      if (!res.ok || !result.ok) throw new Error(result.error || 'Không lưu được route cache.');
      cacheRoutesDirty = false;
      applyRuntimeConfig(result);
      renderCacheManager();
      await refreshCacheManager({ quiet: true, force: true });
      if (el.cacheStatus) el.cacheStatus.textContent = 'Đã lưu route cục bộ; chưa gọi API TTS. Hãy chạy tts:plan để xem mục cần tạo.';
      if (autoGenerate && String(el.ttsToken?.value || '').trim()) {
        await generateMissingCaches({ useCurrentRoutes: true, automatic: true });
      }
      return true;
    } catch (error) {
      if (el.cacheStatus) el.cacheStatus.textContent = error.message || 'Không lưu được route cache.';
      return false;
    } finally {
      el.cacheSave.disabled = false;
    }
  }

  function renderCatalogManager() {
    if (!el.catalogList) return;
    el.catalogList.replaceChildren();
    for (const voice of cacheCatalog) {
      const row = document.createElement('div');
      row.className = 'catalog-row';
      row.textContent = `${voice.label || voice.voice} · ${voice.model} · ${voice.voice}`;
      el.catalogList.appendChild(row);
    }
    if (el.catalogSummary) el.catalogSummary.textContent = `${cacheCatalog.length} voice/model`;
    if (el.generateRouteSelect) {
      const selected = el.generateRouteSelect.value;
      el.generateRouteSelect.replaceChildren();
      for (const voice of cacheCatalog) {
        const option = document.createElement('option');
        option.value = routeValue({ model: voice.model, voice: voice.voice || voice.id });
        option.textContent = voice.label || `${voice.model} · ${voice.voice || voice.id}`;
        el.generateRouteSelect.appendChild(option);
      }
      if ([...el.generateRouteSelect.options].some(option => option.value === selected)) el.generateRouteSelect.value = selected;
    }
    renderPrefixRouteManager();
  }

  function prefixRouteValue(rule) {
    return rule ? routeValue(rule) : '';
  }

  function prefixToneSummary(rule) {
    const names = PREFIX_TONES
      .filter(tone => rule?.excludeTones?.includes(tone.index))
      .map(tone => tone.label);
    return names.length ? `, bỏ qua: ${names.join(', ')}` : '';
  }

  function renderPrefixRouteManager() {
    if (!el.prefixRouteSelect || !el.prefixRouteList) return;
    const selected = el.prefixRouteSelect.value;
    el.prefixRouteSelect.replaceChildren();
    for (const voice of cacheCatalog) {
      const route = { model: voice.model, voice: voice.voice || voice.id };
      const option = document.createElement('option');
      option.value = routeValue(route);
      option.textContent = voice.label || `${route.model} · ${route.voice}`;
      el.prefixRouteSelect.appendChild(option);
    }
    if ([...el.prefixRouteSelect.options].some(option => option.value === selected)) {
      el.prefixRouteSelect.value = selected;
    }

    el.prefixRouteList.replaceChildren();
    const entries = Object.entries(pendingPrefixRoutes).sort(([a], [b]) => a.localeCompare(b, 'vi'));
    if (!entries.length) {
      const empty = document.createElement('p');
      empty.className = 'prefix-route-empty';
      empty.textContent = 'Chưa có route theo prefix.';
      el.prefixRouteList.appendChild(empty);
      return;
    }
    for (const [prefix, rule] of entries) {
      const row = document.createElement('div');
      row.className = 'prefix-route-row';
      const description = document.createElement('span');
      const voice = cacheCatalog.find(item => (item.voice || item.id) === rule.voice && item.model === rule.model);
      description.textContent = `/${prefix}/ → ${voice?.label || `${rule.model} · ${rule.voice}`}${prefixToneSummary(rule)}`;
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'cache-delete-btn';
      remove.textContent = 'Xoá';
      remove.addEventListener('click', async () => {
        delete pendingPrefixRoutes[prefix];
        cacheRoutesDirty = true;
        renderPrefixRouteManager();
        await saveCacheRoutes();
      });
      row.append(description, remove);
      el.prefixRouteList.appendChild(row);
    }
  }

  async function savePrefixRoute() {
    const prefix = normalizeAudioText(el.prefixRoutePrefix?.value || '').toLowerCase();
    const parser = window.PhonicsParser;
    if (!prefix || parser.splitOnsetRime(prefix).onset.toLowerCase() !== prefix) {
      if (el.cacheStatus) el.cacheStatus.textContent = 'Prefix phải là phụ âm đầu hợp lệ, ví dụ r, ch, th.';
      return;
    }
    const route = routeFromValue(el.prefixRouteSelect?.value);
    if (!route) return;
    const excludeTones = [...(el.prefixToneExclusions?.querySelectorAll('input:checked') || [])]
      .map(input => Number(input.value))
      .filter(index => Number.isInteger(index));
    pendingPrefixRoutes[prefix] = { ...route, excludeTones };
    cacheRoutesDirty = true;
    renderPrefixRouteManager();
    const saved = await saveCacheRoutes({ autoGenerate: true });
    if (saved) {
      el.prefixRoutePrefix.value = '';
      for (const input of el.prefixToneExclusions?.querySelectorAll('input:checked') || []) input.checked = false;
      if (el.cacheStatus) el.cacheStatus.textContent = `Đã lưu route prefix /${prefix}/; các cache phù hợp sẽ dùng giọng này.`;
    }
  }

  async function addCatalogVoice() {
    const model = String(el.catalogModel?.value || '').trim();
    const voice = String(el.catalogVoice?.value || '').trim();
    const label = String(el.catalogLabel?.value || '').trim() || `${model} · ${voice}`;
    if (!model || !voice) {
      if (el.generateStatus) el.generateStatus.textContent = 'Cần nhập cả model và voice ID.';
      return;
    }
    const catalog = [...cacheCatalog, { id: voice, model, voice, label }];
    try {
      const res = await fetch('/api/catalog', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ catalog })
      });
      const result = await res.json();
      if (!res.ok || !result.ok) throw new Error(result.error || 'Không thêm được model/voice.');
      cacheCatalog = result.catalog;
      applyRuntimeConfig({ ...audioRoutes, catalog: cacheCatalog });
      renderCatalogManager();
      renderCacheManager();
      el.catalogModel.value = '';
      el.catalogVoice.value = '';
      el.catalogLabel.value = '';
      if (el.generateStatus) el.generateStatus.textContent = `Đã thêm ${voice}; danh sách cập nhật ngay không cần mở lại web.`;
    } catch (error) {
      if (el.generateStatus) el.generateStatus.textContent = error.message || 'Không thêm được model/voice.';
    }
  }

  function previewCache(entry) {
    if (!entry?.file || entry.status !== 'ready') return;
    stopSpeaking();
    const audio = new Audio('/audio/' + encodeURIComponent(entry.file) + `?v=${audioCacheVersion(entry)}`);
    audio.preload = 'auto';
    audio.playbackRate = Math.max(0.5, Math.min(3, Number(state.rate) || 1));
    currentAudio = audio;
    const clear = () => { if (currentAudio === audio) currentAudio = null; };
    audio.onended = clear;
    audio.onerror = clear;
    audio.play().catch(error => {
      console.error('[TTS] Không nghe thử được cache:', entry.file, error);
      clear();
    });
  }

  function lastJobOutput(job) {
    return String(job?.output || '')
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .slice(-1)[0] || 'Không có log từ tiến trình generate.';
  }

  function hasReadyVariant(text, route) {
    const normalized = canonicalAudioText(text);
    // Cache manager hiển thị cả các entry còn trong manifest nhưng không còn
    // nằm trong data.json hiện tại. Sau generate phải kiểm tra manifest thực tế,
    // không chỉ status plan của data.json, nếu không sẽ báo lỗi giả cho các cache
    // cũ như vậy.
    const isCurrentWord = FLAT.some(item => normalizeAudioText(item.word) === normalizeAudioText(text));
    if (!isCurrentWord) {
      return (audioEntriesByText.get(normalized) || []).some(entry => routeMatches(entry, route));
    }
    // Ví dụ "ot" không còn được đọc bằng file "ot", mà bằng o. → tờ → ót.
    // Chỉ báo generate thành công khi tất cả step thực tế đều đã có đúng voice.
    const audioTexts = new Set(window.PhonicsParser.buildSpellingSteps(normalized).steps
      .map(step => canonicalAudioText(step.audioText || step.text))
      .filter(Boolean));
    return [...audioTexts].every(audioText =>
      (audioEntriesByText.get(audioText) || []).some(entry => routeMatches(entry, route))
    );
  }

  async function quickGenerateCache(text, route, triggerButton) {
    const token = String(el.ttsToken?.value || '').trim();
    if (!token) {
      toggleSettings(true);
      if (el.generateStatus) el.generateStatus.textContent = 'Nhập token trong Cài đặt để thêm nhanh cache.';
      return;
    }
    if (!route) {
      if (el.generateStatus) el.generateStatus.textContent = 'Chưa chọn được model/voice cho cache này.';
      return;
    }
    triggerButton.disabled = true;
    if (el.generateStatus) el.generateStatus.textContent = `Đang tạo thêm ${route.voice} cho "${text}"…`;
    try {
      const res = await fetch('/api/cache/generate', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, text, route })
      });
      const result = await res.json();
      if (!res.ok || !result.ok) throw new Error(result.error || 'Không khởi động được generate.');
      await pollGenerateJob(result.jobId, triggerButton, { text, route });
    } catch (error) {
      triggerButton.disabled = false;
      if (el.generateStatus) el.generateStatus.textContent = error.message || 'Không khởi động được generate.';
    }
  }

  async function pollGenerateJob(jobId, triggerButton = el.generateMissingBtn, expected = null) {
    try {
      const res = await fetch(`/api/cache/generate/${encodeURIComponent(jobId)}`, { cache: 'no-store' });
      const job = await res.json();
      if (el.generateStatus) {
        const lastLine = lastJobOutput(job);
        el.generateStatus.textContent = `${job.status === 'running' ? 'Đang chạy' : job.status}: ${lastLine}`;
      }
      if (job.status === 'running') {
        setTimeout(() => pollGenerateJob(jobId, triggerButton, expected), 900);
      } else {
        if (triggerButton) triggerButton.disabled = false;
        await refreshCacheManager({ quiet: true, force: true });
        const lastLine = lastJobOutput(job);
        if (el.generateStatus) {
          if (job.status === 'completed' && expected && !hasReadyVariant(expected.text, expected.route)) {
            el.generateStatus.textContent = `Generate kết thúc nhưng chưa thấy cache ${expected.voice || expected.route.voice} của "${expected.text}". ${lastLine}`;
          } else if (job.status === 'completed') {
            el.generateStatus.textContent = `Đã generate xong. ${lastLine}`;
          } else {
            el.generateStatus.textContent = `Generate lỗi (mã ${job.exitCode ?? 'không rõ'}). ${lastLine}`;
          }
        }
      }
    } catch (error) {
      if (el.generateStatus) el.generateStatus.textContent = error.message || 'Mất kết nối tới job generate.';
      if (triggerButton) triggerButton.disabled = false;
      if (el.generateMissingBtn) el.generateMissingBtn.disabled = false;
    }
  }

  async function generateMissingCaches({ useCurrentRoutes = false, automatic = false } = {}) {
    const token = String(el.ttsToken?.value || '').trim();
    if (!token) {
      if (el.generateStatus) el.generateStatus.textContent = 'Cần nhập token trước khi generate.';
      return;
    }
    const missingItems = (cacheStatusData?.items || []).filter(item => item.status !== 'ready');
    if (!missingItems.length) {
      if (el.generateStatus) el.generateStatus.textContent = 'Hiện không thiếu cache nào theo data.json và route hiện tại.';
      return;
    }
    const selectedRoute = routeFromValue(el.generateRouteSelect?.value) || audioRoutes.default;
    if (!useCurrentRoutes) {
      for (const item of missingItems) pendingCacheRoutes[canonicalAudioText(item.text)] = selectedRoute;
      if (!(await saveCacheRoutes())) return;
    }
    el.generateMissingBtn.disabled = true;
    if (el.generateStatus) {
      el.generateStatus.textContent = automatic
        ? `Đang tự tạo ${missingItems.length} cache thiếu theo route hiện tại…`
        : `Đang tạo ${missingItems.length} cache bằng ${selectedRoute.voice}…`;
    }
    try {
      const res = await fetch('/api/cache/generate', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token })
      });
      const result = await res.json();
      if (!res.ok || !result.ok) throw new Error(result.error || 'Không khởi động được generate.');
      await pollGenerateJob(result.jobId);
    } catch (error) {
      el.generateMissingBtn.disabled = false;
      if (el.generateStatus) el.generateStatus.textContent = error.message || 'Không khởi động được generate.';
    }
  }

  function toggleSettings(open) {
    if (!el.settingsPanel) return;
    const shouldOpen = typeof open === 'boolean' ? open : el.settingsPanel.classList.contains('hidden');
    el.settingsPanel.classList.toggle('hidden', !shouldOpen);
    if (el.settingsBtn) el.settingsBtn.setAttribute('aria-expanded', String(shouldOpen));
    if (shouldOpen) {
      refreshCacheManager({ quiet: true });
      if (cacheRefreshTimer) clearInterval(cacheRefreshTimer);
      cacheRefreshTimer = setInterval(() => refreshCacheManager({ quiet: true }), 3000);
    } else if (cacheRefreshTimer) {
      clearInterval(cacheRefreshTimer);
      cacheRefreshTimer = null;
    }
  }

  function setControlsOpen(open) {
    const isOpen = Boolean(open);
    if (el.controls) el.controls.classList.toggle('is-open', isOpen);
    if (el.controlsToggle) {
      el.controlsToggle.setAttribute('aria-expanded', String(isOpen));
      const label = el.controlsToggle.querySelector('.controls-toggle-label');
      if (label) label.textContent = isOpen ? 'Ẩn đi' : 'BẤM VÀO ĐÂY ĐỂ KÉO LÊN';
    }
  }

  function initCacheManager() {
    if (el.controlsToggle) {
      el.controlsToggle.addEventListener('click', () => {
        setControlsOpen(!el.controls?.classList.contains('is-open'));
      });
      setControlsOpen(false);
    }
    if (el.cacheSearch) el.cacheSearch.addEventListener('input', renderCacheManager);
    if (el.cacheRefresh) el.cacheRefresh.addEventListener('click', refreshCacheManager);
    if (el.cacheSave) el.cacheSave.addEventListener('click', () => saveCacheRoutes({ autoGenerate: true }));
    if (el.catalogAddBtn) el.catalogAddBtn.addEventListener('click', addCatalogVoice);
    if (el.prefixRouteAdd) el.prefixRouteAdd.addEventListener('click', savePrefixRoute);
    if (el.generateMissingBtn) el.generateMissingBtn.addEventListener('click', () => generateMissingCaches());
    if (el.settingsBtn) el.settingsBtn.addEventListener('click', () => toggleSettings());
    if (el.settingsClose) el.settingsClose.addEventListener('click', () => toggleSettings(false));
  }

  async function loadAudioManifest() {
    try {
      const [manifestRes, routesRes, statusRes] = await Promise.all([
        fetchAudioManifest(),
        STATIC_DEPLOY
          ? fetch(publicUrl('tts-routes.json'), { cache: 'no-store' })
          : fetch('/api/cache-routes', { cache: 'no-store' }),
        STATIC_DEPLOY
          ? Promise.resolve({ ok: false })
          : fetch('/api/settings', { cache: 'no-store' })
      ]);
      if (!manifestRes.ok) throw new Error('Chưa có audio-cache/manifest.json. Hãy chạy npm run tts:generate.');
      const manifest = await manifestRes.json();
      const routeConfig = routesRes.ok ? await routesRes.json() : audioRoutes;
      cacheStatusData = statusRes.ok ? await statusRes.json() : null;
      if (manifest.schemaVersion !== 1) throw new Error('Manifest TTS không đúng phiên bản.');
      setAudioManifest(manifest, routeConfig);
      if (!STATIC_DEPLOY) {
        renderCatalogManager();
        renderCacheManager();
      }
      audioManifestError = null;
    } catch (error) {
      audioManifestError = error;
      console.error('[TTS] Không tải được cache âm thanh:', error);
    }
  }

  function stopSpeaking() {
    if (activeSpeechCancel) {
      activeSpeechCancel();
      return;
    }
    if (currentAudio) {
      currentAudio.pause();
      currentAudio.currentTime = 0;
      currentAudio = null;
    }
  }

  async function enterPresentationMode() {
    document.documentElement.classList.add('presentation-mode');
    // Browsers intentionally do not expose whether USB/HDMI/VGA is connected.
    // Fullscreen is the safe, user-gesture-compatible presentation mode.
    try {
      if (!document.fullscreenElement && document.documentElement.requestFullscreen) {
        await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
      }
    } catch (_) {
      // Fullscreen can be denied by browser policy; the responsive presentation
      // class remains active and the lesson still starts normally.
    }
    try {
      if ('wakeLock' in navigator && !presentationWakeLock) {
        presentationWakeLock = await navigator.wakeLock.request('screen');
      }
    } catch (_) {}
  }

  async function leavePresentationMode() {
    document.documentElement.classList.remove('presentation-mode');
    try { await presentationWakeLock?.release(); } catch (_) {}
    presentationWakeLock = null;
    try {
      if (document.fullscreenElement && document.exitFullscreen) await document.exitFullscreen();
    } catch (_) {}
  }

  function speak(text, rate, fallbackText = '', word = '') {
    return new Promise(resolve => {
      stopSpeaking();
      const normalizedText = normalizeAudioText(text);
      if (!normalizedText) { resolve(); return; }
      // Cho phép chạy an toàn với cache cũ trong lúc bổ sung các bản đọc đã
      // được làm rõ bằng dấu chấm (o. / ô. / ư.). Khi cache mới có mặt, entry
      // chính luôn được ưu tiên; fallback chỉ là cầu nối, không thay đổi khóa
      // cache hay nội dung hiển thị.
      const fallback = normalizeAudioText(fallbackText);
      const entry = selectAudioEntry(normalizedText, word) ||
        (fallback && fallback !== normalizedText ? selectAudioEntry(fallback, word) : null);
      if (!entry) {
        console.error('[TTS] Thiếu file cache cho:', normalizedText,
          audioManifestError?.message || 'chưa generate audio');
        resolve();
        return;
      }

      let done = false;
      let timeoutId = null;
      const audio = cachedAudioElement(entry.url);
      audio.pause();
      audio.currentTime = 0;
      audio.playbackRate = Math.max(0.5, Math.min(3, Number(rate) || 1));
      currentAudio = audio;

      const finish = () => {
        if (done) return;
        done = true;
        if (timeoutId) clearTimeout(timeoutId);
        if (currentAudio === audio) currentAudio = null;
        if (activeSpeechCancel === cancel) activeSpeechCancel = null;
        resolve();
      };
      const cancel = () => {
        audio.pause();
        audio.currentTime = 0;
        finish();
      };
      activeSpeechCancel = cancel;
      audio.onended = finish;
      audio.onerror = finish;
      // Không để một file hỏng làm kẹt chuỗi đánh vần.
      timeoutId = setTimeout(finish, 20_000);
      audio.play().catch(error => {
        console.error('[TTS] Không phát được file cache:', entry.file, error);
        finish();
      });
    });
  }

  /* ======================================================================
     8. PHÁT 1 TỪ: đồng bộ audio + ánh sáng đỏ theo từng bước của engine
     ====================================================================== */
  function transitionPauseMs(seconds) {
    // Đây là khoảng nghỉ thật giữa các bước, độc lập hoàn toàn với tốc độ
    // phát WAV. 0,5 giây là mặc định để phần đầu -> phần cuối -> từ rõ ràng.
    const safeSeconds = Math.max(0, Math.min(5, Number(seconds) || 0));
    return Math.round(safeSeconds * 1000);
  }

  function waitForTransition(seconds) {
    return new Promise(resolve => setTimeout(resolve, transitionPauseMs(seconds)));
  }

  async function playWord(item, myToken, { skipInitialFade = false } = {}) {
    if (myToken === state.playToken) state.isReading = true;
    const { onset, rime } = splitForDisplay(item.word);
    const parsedSteps = window.PhonicsParser.buildSpellingSteps(item.word).steps;
    const faceLetterMode = state.spellingMode === LETTERS_ONLY_MODE;
    const steps = faceLetterMode ? buildFaceLetterSteps(item.word) : parsedSteps;
    const voiceForWord = state.voice;
    const toneIdx = steps.findIndex(s => s.type === 'tone');
    let mergeIdx;
    if (toneIdx > 0 && steps[toneIdx - 1].type === 'combine') mergeIdx = toneIdx - 1;
    else if (toneIdx === -1) mergeIdx = steps.length - 1;
    else mergeIdx = -1; // không có bước ghép riêng — lộ diện ngay ở bước "tone"

    const totalTokenSteps = steps.filter(s => s.type === 'token').length;
    const onsetNonEmpty = !!onset;

    let tokenSeen = 0;
    let rimePointer = 0;
    const rimeLen = Array.from(rime).length;
    let shownOnset = false;
    let shownRime = '';

    function setUnifiedText(text) {
      const visibleText = String(text || '');
      setCellChars(el.mergeText, visibleText);
      const visibleLength = Array.from(visibleText).length;
      el.mergeCell.dataset.length = String(visibleLength);
      el.mergeCell.classList.remove('text-size-short', 'text-size-medium', 'text-size-long', 'text-size-xlong');
      el.mergeCell.classList.add(
        visibleLength >= 8 ? 'text-size-xlong' :
        visibleLength >= 6 ? 'text-size-long' :
        visibleLength >= 5 ? 'text-size-medium' : 'text-size-short'
      );
      el.mergeCell.classList.remove('hidden');
      el.mergeCell.classList.add('visible');
    }

    function renderPartial() {
      setUnifiedText(`${shownOnset ? tonelessOf(onset) : ''}${shownRime}`);
    }

    function highlightUnified(from = 0, to = null) {
      const end = to == null ? from : to;
      clearLit(el.mergeText);
      litRange(el.mergeText, from, end);
    }

    function revealMerge(text) {
      setUnifiedText(text);
      litAll(el.mergeText);
    }

    for (let i = 0; i < steps.length; i++) {
      if (myToken !== state.playToken) return;
      const step = steps[i];

      // Áp dụng hiệu ứng sáng / hiển thị NGAY TRƯỚC khi phát âm, để "đọc đến đâu sáng
      // đến đấy" thay vì đọc xong mới sáng (trước đây gọi sau await speak nên bị lệch
      // 1 nhịp — luôn chậm hơn giọng đọc).
      if (step.type === 'letter') {
        const nextChar = Array.from(rime)[rimePointer] || '';
        shownRime += nextChar;
        rimePointer++;
        renderPartial();
        highlightUnified((shownOnset ? Array.from(tonelessOf(onset)).length : 0) + shownRime.length - 1);

      } else if (step.type === 'token') {
        tokenSeen++;
        const isOnsetToken = faceLetterMode
          ? (onsetNonEmpty && tokenSeen === 1)
          : ((totalTokenSteps === 2 && tokenSeen === 2) ||
             (totalTokenSteps === 1 && onsetNonEmpty));
        if (isOnsetToken) {
          shownOnset = true;
          renderPartial();
          highlightUnified(0, Array.from(tonelessOf(onset)).length - 1);
        } else {
          shownRime = rime;
          renderPartial();
          const onsetLength = shownOnset ? Array.from(tonelessOf(onset)).length : 0;
          // Token này là phụ âm cuối (c/ch/m/n/ng/nh/p/t). Chỉ phần mới
          // được đọc mới sáng; không làm đỏ lại toàn bộ vần nguyên âm đã đọc.
          const finalPart = window.PhonicsParser.splitNucleusFinal(rime).final || '';
          const finalStart = Math.max(0, rimeLen - Array.from(finalPart).length);
          highlightUnified(onsetLength + finalStart, onsetLength + rimeLen - 1);
        }

      } else if (step.type === 'combine') {
        shownRime = rime;
        renderPartial();
        const onsetLength = shownOnset ? Array.from(tonelessOf(onset)).length : 0;
        const fullText = `${tonelessOf(onset)}${rime}`;
        if (shownOnset && tonelessOf(step.text) === fullText) {
          litAll(el.mergeText);
        } else if (shownOnset) {
          highlightUnified(onsetLength, onsetLength + rimeLen - 1);
        } else {
          litAll(el.mergeText);
        }

      } else if (step.type === 'tone') {
        setUnifiedText(item.word);
        const wchars = Array.from(item.word);
        const tchars = Array.from(tonelessOf(item.word));
        const toneCharIdx = wchars.findIndex((c, idx) => c !== tchars[idx]);
        if (toneCharIdx >= 0) {
          // Khi đọc tên dấu, toàn bộ chữ về màu đen; chỉ ký tự mang dấu
          // được bật đỏ/glow để học sinh nhìn đúng vị trí của dấu thanh.
          litOnly(el.mergeText, toneCharIdx);
          const spans = el.mergeText.querySelectorAll('.ch');
          if (spans[toneCharIdx]) spans[toneCharIdx].classList.add('tone-pulse');
        } else {
          clearLit(el.mergeText);
        }

      } else if (step.type === 'final') {
        setUnifiedText(item.word);
        litAll(el.mergeText);
        el.mergeCell.classList.add('final-glow');
      }

      // Một tốc độ đọc duy nhất áp dụng cho cả đánh vần và đọc từ hoàn chỉnh.
      // transitionDelay chỉ điều khiển khoảng nghỉ sau bước này.
      // Cả hai chế độ đều dùng đúng giọng/cache LeminH. Chế độ mặt chữ chỉ
      // thay danh sách bước, không tắt phát âm.
      await speak(step.audioText || step.text, state.rate, step.text, item.word);
      // Glow/màu đỏ chỉ tồn tại trong đúng thời gian audio của bước đang đọc.
      // Khi audio kết thúc, chuyển mềm về màu đen thay vì để chữ đỏ cố định.
      if (step.type === 'final') el.mergeCell.classList.remove('final-glow');
      fadeLit(el.mergeText);
      if (myToken !== state.playToken) return;
      if (step.type !== 'final') {
        await waitForTransition(state.transitionDelay);
        if (myToken !== state.playToken) return;
      }
    }

    // ---- Chế độ TỰ ĐỘNG: sau khi đọc xong trọn vẹn từ này (không bị ngắt giữa
    // chừng bởi thao tác khác), tự chuyển sang từ kế tiếp sau một khoảng nghỉ ngắn.
    // Bất kỳ thao tác "từ bên ngoài" nào (bấm nút, phím mũi tên...) đều gọi
    // stopAutoPlay() TRƯỚC khi điều hướng, nên state.playToken sẽ đổi và hẹn giờ này
    // tự huỷ tác dụng (xem điều kiện kiểm tra bên trong setTimeout).
    if (myToken !== state.playToken) return;
    state.isReading = false;
    scheduleAutoAdvance(myToken);
  }

  /* ======================================================================
     9. DỰNG LẠI GIAO DIỆN CHO TỪ HIỆN TẠI
     ====================================================================== */
  function renderHome() {
    state.started = false;
    state.isReading = false;
    state.playToken++;
    stopAutoPlay();
    stopSpeaking();
    leavePresentationMode();
    if (el.stage) el.stage.classList.add('home-active');
    if (el.letter) el.letter.textContent = 'BÉ HỌC ĐÁNH VẦN';
  }

  function renderKeyCarousel() {
    if (!el.keyCarouselTrack || !KEYS.length || !window.Splide) return;
    const currentKeyIndex = FLAT[state.flatIndex]?.keyIndex ?? 0;
    if (!keyCarouselInstance) {
      el.keyCarouselTrack.replaceChildren();
      KEYS.forEach((key, keyIndex) => {
        const item = document.createElement('li');
        item.className = 'splide__slide key-slide';
        item.dataset.keyIndex = String(keyIndex);
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'key-slide-button';
        button.textContent = key;
        button.title = `Bắt đầu đọc nhóm ${key}`;
        button.setAttribute('aria-label', `Mở nhóm ${key}`);
        button.addEventListener('click', () => {
          const targetIndex = Number(item.dataset.keyIndex);
          navigateFromCarousel(targetIndex);
        });
        item.appendChild(button);
        el.keyCarouselTrack.appendChild(item);
      });
      keyCarouselInstance = new window.Splide(el.keyCarousel, {
        type: 'loop',
        perPage: Math.min(4, KEYS.length),
        perMove: 1,
        focus: 'center',
        gap: 'clamp(10px, 2vw, 28px)',
        arrows: false,
        pagination: false,
        drag: true,
        snap: true,
        speed: 520,
        easing: 'cubic-bezier(.22,.75,.2,1)',
        rewind: false,
        keyboard: false,
        breakpoints: {
          560: { perPage: Math.min(3, KEYS.length), gap: '12px' },
          380: { perPage: Math.min(2, KEYS.length), gap: '10px' }
        }
      });
      keyCarouselInstance.on('move', index => {
        if (suppressCarouselMove) {
          suppressCarouselMove = false;
          return;
        }
        const destinationSlide = keyCarouselInstance.Components.Slides.getAt(index)?.slide;
        const activeSlide = destinationSlide || el.keyCarousel.querySelector('.splide__slide.is-active[data-key-index]');
        const targetIndex = Number(activeSlide?.dataset.keyIndex);
        if (!Number.isInteger(targetIndex) || targetIndex === FLAT[state.flatIndex]?.keyIndex) return;
        navigateFromCarousel(targetIndex);
      });
      keyCarouselInstance.mount();
    }
    if (keyCarouselInstance.index !== currentKeyIndex) {
      suppressCarouselMove = true;
      keyCarouselInstance.go(currentKeyIndex);
    }
    el.keyCarousel.classList.toggle('is-ready', true);
  }

  function moveKeyBy(delta) {
    if (!keyCarouselInstance || !KEYS.length) return;
    keyCarouselInstance.go(delta > 0 ? '>' : '<');
  }

  function navigateFromCarousel(targetIndex) {
    if (!Number.isInteger(targetIndex) || !KEYS[targetIndex]) return;
    if (targetIndex === (FLAT[state.flatIndex]?.keyIndex ?? 0)) return;
    // Carousel navigation is intentionally allowed while audio is playing:
    // stop the current step immediately, then start the selected key.
    stopAutoPlay();
    stopSpeaking();
    state.isReading = false;
    state.playToken++;
    state.flatIndex = KEY_FIRST_FLAT_INDEX[KEYS[targetIndex]];
    renderCurrent();
  }

  function bindKeyCarousel() {
    // Splide is initialized lazily after data.json has loaded.
  }

  function renderCurrent() {
    state.started = true;
    if (el.stage) el.stage.classList.remove('home-active');
    state.playToken++;
    const myToken = state.playToken;
    const item = FLAT[state.flatIndex];
    const { onset, rime } = splitForDisplay(item.word);

    // ---- Header ----
    el.letter.textContent = item.key;
    el.letter.classList.remove('pop');
    void el.letter.offsetWidth; // reflow để animation chạy lại
    el.letter.classList.add('pop');
    if (el.wholeWordCaption) el.wholeWordCaption.textContent = item.word;

    // ---- Footer ----
    el.keyPos.textContent = item.keyIndex + 1;
    el.wordPos.textContent = `từ ${item.wordIndexInKey + 1}/${item.totalWordsInKey}`;
    const prevKey = KEYS[item.keyIndex - 1];
    const nextKey = KEYS[item.keyIndex + 1];
    el.prevKeyLabel.textContent = prevKey || '—';
    el.nextKeyLabel.textContent = nextKey || '—';
    el.prevKeyBtn.disabled = !prevKey;
    el.nextKeyBtn.disabled = !nextKey;
    renderKeyCarousel();
    if (el.mainPrevBtn) el.mainPrevBtn.disabled = state.flatIndex <= 0;
    if (el.mainNextBtn) el.mainNextBtn.disabled = state.flatIndex >= FLAT.length - 1;

    // ---- Ô Phần đầu / Phần cuối ----
    el.onsetCell.classList.remove('visible');
    el.rimeCell.classList.remove('visible');
    el.rimeCell.classList.remove('hidden');
    el.mergeCell.classList.add('hidden');
    el.mergeCell.classList.remove('visible');
    el.mergeCell.dataset.length = '0';
    setCellChars(el.mergeText, '');
    el.mergeCell.classList.remove('final-glow');
    clearLit(el.onsetText);
    clearLit(el.rimeText);
    warmAudioForItem(item);
    warmAudioForItem(FLAT[(state.flatIndex + 1) % FLAT.length]);

    const onsetOnly = !!onset && !rime;
    if (onset) {
      el.onsetCell.classList.remove('empty');
      el.rimeCell.classList.remove('solo');
      setCellChars(el.onsetText, onset);
    } else {
      el.onsetCell.classList.add('empty');
      el.rimeCell.classList.add('solo');
      setCellChars(el.onsetText, '');
    }
    setCellChars(el.rimeText, rime);
    if (onsetOnly) el.rimeCell.classList.add('hidden');

    // Từ nay chỉ một vùng chữ hợp nhất được hiển thị. Các ID cũ vẫn được giữ
    // phía sau để không làm thay đổi parser, audio và animation hiện có.
    el.mergeCell.classList.remove('hidden');
    el.mergeCell.classList.add('visible');

    // fade-in mượt: đợi 1 khung hình để transition CSS bắt được thay đổi
    requestAnimationFrame(() => {
      if (onset) el.onsetCell.classList.add('visible');
      if (!onsetOnly) el.rimeCell.classList.add('visible');
    });

    playWord(item, myToken);
  }

  /* ======================================================================
     10. ĐIỀU HƯỚNG
     ====================================================================== */
  function scheduleAutoAdvance(myToken = state.playToken) {
    if (state.autoTimer) {
      clearTimeout(state.autoTimer);
      state.autoTimer = null;
    }
    if (!state.autoPlay || state.isReading || myToken !== state.playToken) return;
    state.autoTimer = setTimeout(() => {
      state.autoTimer = null;
      if (!state.autoPlay || state.isReading || myToken !== state.playToken) return;
      const isLast = state.flatIndex >= FLAT.length - 1;
      goTo(isLast ? 0 : state.flatIndex + 1);
    }, 650);
  }

  function goTo(index) {
    if (index < 0 || index >= FLAT.length) return;
    state.flatIndex = index;
    renderCurrent();
  }

  function next() { goTo(state.flatIndex + 1); }
  function prev() { goTo(state.flatIndex - 1); }

  // Tắt chế độ tự động: gọi TRƯỚC mọi điều hướng do người dùng chủ động thực hiện
  // (bấm nút chuyển từ/chuyển chữ, bấm nghe lại, dùng phím mũi tên...), đúng theo
  // yêu cầu "có input từ ngoài thì dừng lại". Việc goTo() do CHÍNH auto-timer gọi
  // (bên trong playWord) không đi qua hàm này nên không tự tắt chính nó.
  function stopAutoPlay() {
    if (state.autoTimer) { clearTimeout(state.autoTimer); state.autoTimer = null; }
    if (!state.autoPlay) return;
    state.autoPlay = false;
    if (el.autoPlayToggle) el.autoPlayToggle.checked = false;
  }

  // Gọi khi có bất kỳ thao tác điều hướng thủ công nào: tắt tự động + im lặng
  // ngay lập tức, kể cả khi thao tác đó không thực sự đổi sang từ khác (vd
  // bấm mũi tên khi đã ở từ đầu/cuối danh sách).
  function handleManualInput() {
    if (state.isReading) return false;
    stopAutoPlay();
    stopSpeaking();
    // Hủy cả playWord đang chờ preload/audio. Nếu chỉ dừng thẻ audio, promise
    // cũ có thể tiếp tục sang bước kế tiếp sau khi request kết thúc.
    state.playToken++;
    return true;
  }

  el.prevKeyBtn.addEventListener('click', () => {
    if (!handleManualInput()) return;
    const item = FLAT[state.flatIndex];
    const prevKey = KEYS[item.keyIndex - 1];
    if (prevKey) goTo(KEY_FIRST_FLAT_INDEX[prevKey]);
  });
  el.nextKeyBtn.addEventListener('click', () => {
    if (!handleManualInput()) return;
    const item = FLAT[state.flatIndex];
    const nextKey = KEYS[item.keyIndex + 1];
    if (nextKey) goTo(KEY_FIRST_FLAT_INDEX[nextKey]);
  });

  el.replayBtn.addEventListener('click', () => {
    if (!handleManualInput()) return;
    // Dựng lại trạng thái ô chữ để lần nghe lại bắt đầu từ màu chưa sáng,
    // nếu không người dùng sẽ tưởng các bước chuyển không chạy.
    renderCurrent();
  });

  document.addEventListener('keydown', (e) => {
    // Khi đang focus slider/select/input, để trình duyệt xử lý phím mũi tên
    // của chính control đó; không được biến ArrowRight thành chuyển từ.
    const target = e.target;
    if (target && ['INPUT', 'SELECT', 'TEXTAREA'].includes(target.tagName)) return;
    if (e.key === 'ArrowRight' || e.key === 'PageDown') {
      e.preventDefault();
      if (handleManualInput()) next();
    } else if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
      e.preventDefault();
      if (handleManualInput()) prev();
    }
  });

  if (el.mainPrevBtn) el.mainPrevBtn.addEventListener('click', () => {
    if (handleManualInput()) prev();
  });
  if (el.mainNextBtn) el.mainNextBtn.addEventListener('click', () => {
    if (handleManualInput()) next();
  });

  el.rateSlider.addEventListener('input', () => {
    state.rate = parseFloat(el.rateSlider.value);
    state.speedMode = 'custom';
    el.rateValue.textContent = state.rate.toFixed(1) + '×';
    updateSpeedModeUI();
    persistPlaybackSettings();
    // File WAV đã tạo một lần; chỉ đổi tốc độ phát, không gọi lại API.
    if (currentAudio) currentAudio.playbackRate = state.rate;
  });

  el.transitionSlider.addEventListener('input', () => {
    state.transitionDelay = parseFloat(el.transitionSlider.value);
    state.speedMode = 'custom';
    el.transitionValue.textContent = state.transitionDelay.toFixed(1) + 's';
    updateSpeedModeUI();
    persistPlaybackSettings();
  });

  el.speedPresets?.forEach(button => {
    button.addEventListener('click', () => setSpeedMode(button.dataset.speedMode));
  });

  if (el.voiceSelect) {
    state.voice = el.voiceSelect.value || state.voice;
    el.voiceSelect.addEventListener('change', () => {
    state.voice = el.voiceSelect.value;
      if (!handleManualInput()) return;
      playWord(FLAT[state.flatIndex], state.playToken);
    });
  }

  initCacheManager();
  bindKeyCarousel();
  loadPlaybackSettings();

  if (el.startBtn) {
    el.startBtn.addEventListener('click', () => {
      state.started = true;
      enterPresentationMode();
      renderCurrent();
    });
  }
  if (el.homeSettingsBtn) el.homeSettingsBtn.addEventListener('click', () => toggleSettings(true));
  if (el.exitBtn) {
    el.exitBtn.addEventListener('click', () => el.exitDialog?.classList.remove('hidden'));
  }
  if (el.exitStayBtn) el.exitStayBtn.addEventListener('click', () => el.exitDialog?.classList.add('hidden'));
  if (el.exitConfirmBtn) el.exitConfirmBtn.addEventListener('click', () => {
    el.exitDialog?.classList.add('hidden');
    renderHome();
  });

  if (el.readingModeSelect) {
    state.spellingMode = el.readingModeSelect.value || state.spellingMode;
    el.readingModeSelect.addEventListener('change', () => {
      state.spellingMode = el.readingModeSelect.value;
      if (!handleManualInput()) return;
      renderCurrent();
    });
  }

  if (el.autoPlayToggle) {
    el.autoPlayToggle.addEventListener('change', () => {
      state.autoPlay = el.autoPlayToggle.checked;
      if (!state.autoPlay && state.autoTimer) {
        clearTimeout(state.autoTimer);
        state.autoTimer = null;
      } else if (state.autoPlay && !state.isReading) {
        scheduleAutoAdvance();
      }
    });
  }

  /* ======================================================================
     11. TẢI DỮ LIỆU (data.json) & KHỞI ĐỘNG
     ====================================================================== */
  async function init() {
    try {
      const res = await fetch(DATA_URL, { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      DATA = await res.json();
    } catch (err) {
      // Lỗi thường gặp: mở file index.html trực tiếp qua đường dẫn file:// khiến
      // trình duyệt chặn fetch() vì lý do CORS — cần chạy qua 1 local server
      // (vd: VS Code Live Server, `npx serve`, `python3 -m http.server`...).
      console.error('Không tải được dữ liệu từ "' + DATA_URL + '":', err);
      el.letter.textContent = '!';
      if (el.wholeWordCaption) el.wholeWordCaption.textContent =
        'Không tải được ' + DATA_URL + ' — hãy chạy trang qua local server thay vì mở trực tiếp file.';
      return;
    }

    const { keys, flat, firstIndex } = flattenData(DATA);
    KEYS = keys;
    FLAT = flat;
    KEY_FIRST_FLAT_INDEX = firstIndex;
    await loadAudioManifest();

    if (FLAT.length === 0) {
      el.letter.textContent = '!';
      if (el.wholeWordCaption) el.wholeWordCaption.textContent = 'data.json không có dữ liệu nào.';
      return;
    }

    el.keyTotal.textContent = KEYS.length;
    renderHome();
  }

  init();

})();
