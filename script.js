(function () {
  'use strict';

  /* ======================================================================
     1. DỮ LIỆU
     Trước đây dữ liệu được dán trực tiếp ở đây. Giờ được tải từ file JSON
     ngoài (data.json, đặt cùng thư mục với index.html) qua fetch() ở mục 11
     bên dưới, để dễ chỉnh sửa/thay bộ từ mà không cần đụng vào code.
     Định dạng file data.json: { "a": ["a","à",...], "b": [...], ... }
     ====================================================================== */
  const DATA_URL = 'data.json';

  let DATA = null;

  /* ======================================================================
     2. LÀM PHẲNG DỮ LIỆU
     (chuyển thành hàm vì giờ chỉ chạy được SAU KHI tải xong data.json —
     xem hàm flattenData() và init() ở mục 11)
     ====================================================================== */
  let KEYS = [];
  let FLAT = [];
  let KEY_FIRST_FLAT_INDEX = {};

  function flattenData(data) {
    const keys = Object.keys(data);
    const flat = [];
    keys.forEach((key, keyIndex) => {
      const words = data[key];
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
    rate: 0.9,
    playToken: 0,
    autoPlay: false,
    autoTimer: null
  };

  /* ======================================================================
     4. DOM
     ====================================================================== */
  const el = {
    letter: document.getElementById('letterDisplay'),
    wholeWordCaption: document.getElementById('wholeWordCaption'),
    onsetCell: document.getElementById('onsetCell'),
    onsetText: document.getElementById('onsetText'),
    rimeCell: document.getElementById('rimeCell'),
    rimeText: document.getElementById('rimeText'),
    mergeCell: document.getElementById('mergeCell'),
    mergeText: document.getElementById('mergeText'),
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
    autoPlayToggle: document.getElementById('autoPlayToggle')
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
        rime: chars.slice(onsetLen).join('')
      };
    }

    let onsetLen = 0;
    for (const pat of ONSET_ORDER_DISPLAY) {
      if (toneless.startsWith(pat)) { onsetLen = pat.length; break; }
    }
    return {
      onset: chars.slice(0, onsetLen).join(''),
      rime: chars.slice(onsetLen).join('')
    };
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
      s.classList.remove('lit', 'tone-pulse');
    });
  }

  function litAll(container) {
    container.querySelectorAll('.ch').forEach(s => s.classList.add('lit'));
  }

  function litRange(container, from, to) {
    const spans = container.querySelectorAll('.ch');
    for (let i = from; i <= to; i++) {
      if (spans[i]) spans[i].classList.add('lit');
    }
  }

  /* ======================================================================
     7. WEB SPEECH API — speak() trả về Promise, không đè âm thanh
     ====================================================================== */
  let cachedVoices = [];
  function refreshVoices() {
    if ('speechSynthesis' in window) cachedVoices = window.speechSynthesis.getVoices();
  }
  if ('speechSynthesis' in window) {
    refreshVoices();
    window.speechSynthesis.onvoiceschanged = refreshVoices;
  }

  function speak(text, rate) {
    return new Promise(resolve => {
      if (!('speechSynthesis' in window) || !text) { resolve(); return; }
      window.speechSynthesis.cancel();
      const utter = new SpeechSynthesisUtterance(text);
      utter.lang = 'vi-VN';
      utter.rate = rate;
      const viVoice = cachedVoices.find(v => v.lang && v.lang.toLowerCase().startsWith('vi'));
      if (viVoice) utter.voice = viVoice;
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };
      utter.onend = finish;
      utter.onerror = finish;
      // an toàn: nếu trình duyệt "nuốt" sự kiện, không để app treo mãi
      setTimeout(finish, 4000);
      window.speechSynthesis.speak(utter);
    });
  }

  /* ======================================================================
     8. PHÁT 1 TỪ: đồng bộ audio + ánh sáng đỏ theo từng bước của engine
     ====================================================================== */
  async function playWord(item, myToken, { skipInitialFade = false } = {}) {
    const { onset, rime } = splitForDisplay(item.word);
    const { steps } = window.PhonicsParser.buildSpellingSteps(item.word);

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
    let merged = false;

    function revealMerge(text) {
      setCellChars(el.mergeText, text);
      el.mergeCell.classList.remove('hidden');
      // BUG CŨ: chỉ gỡ 'hidden' (chỉ điều khiển display:none) mà KHÔNG thêm 'visible'
      // (điều khiển opacity/transform theo CSS .cell). Kết quả: ô combine có chữ bên
      // trong nhưng opacity:0 nên nhìn như 1 ô trống. Cần thêm 'visible' ở đây.
      el.mergeCell.classList.add('visible');
      litAll(el.mergeText);
      merged = true;
    }

    for (let i = 0; i < steps.length; i++) {
      if (myToken !== state.playToken) return;
      const step = steps[i];

      // Áp dụng hiệu ứng sáng / hiển thị NGAY TRƯỚC khi phát âm, để "đọc đến đâu sáng
      // đến đấy" thay vì đọc xong mới sáng (trước đây gọi sau await speak nên bị lệch
      // 1 nhịp — luôn chậm hơn giọng đọc).
      if (step.type === 'letter') {
        litRange(el.rimeText, rimePointer, rimePointer);
        rimePointer++;

      } else if (step.type === 'token') {
        tokenSeen++;
        const isOnsetToken =
          (totalTokenSteps === 2 && tokenSeen === 2) ||
          (totalTokenSteps === 1 && onsetNonEmpty);
        if (isOnsetToken) litAll(el.onsetText);
        else litRange(el.rimeText, rimePointer, rimeLen - 1);

      } else if (step.type === 'combine') {
        if (i === mergeIdx) revealMerge(step.text);
        else litAll(el.rimeText);

      } else if (step.type === 'tone') {
        if (!merged) revealMerge(item.word);
        else setCellChars(el.mergeText, item.word);
        litAll(el.mergeText);
        const wchars = Array.from(item.word);
        const tchars = Array.from(tonelessOf(item.word));
        const toneCharIdx = wchars.findIndex((c, idx) => c !== tchars[idx]);
        const spans = el.mergeText.querySelectorAll('.ch');
        if (toneCharIdx >= 0 && spans[toneCharIdx]) spans[toneCharIdx].classList.add('tone-pulse');

      } else if (step.type === 'final') {
        if (!merged) revealMerge(step.text);
        setCellChars(el.mergeText, item.word);
        litAll(el.mergeText);
        litAll(el.onsetText);
        litAll(el.rimeText);
        el.mergeCell.classList.add('final-glow');
      }

      await speak(step.text, state.rate);
      if (myToken !== state.playToken) return;
    }

    // ---- Chế độ TỰ ĐỘNG: sau khi đọc xong trọn vẹn từ này (không bị ngắt giữa
    // chừng bởi thao tác khác), tự chuyển sang từ kế tiếp sau một khoảng nghỉ ngắn.
    // Bất kỳ thao tác "từ bên ngoài" nào (bấm nút, phím mũi tên...) đều gọi
    // stopAutoPlay() TRƯỚC khi điều hướng, nên state.playToken sẽ đổi và hẹn giờ này
    // tự huỷ tác dụng (xem điều kiện kiểm tra bên trong setTimeout).
    if (state.autoPlay) {
      if (state.autoTimer) clearTimeout(state.autoTimer);
      state.autoTimer = setTimeout(() => {
        if (!state.autoPlay || myToken !== state.playToken) return;
        const isLast = state.flatIndex >= FLAT.length - 1;
        goTo(isLast ? 0 : state.flatIndex + 1);
      }, 900);
    }
  }

  /* ======================================================================
     9. DỰNG LẠI GIAO DIỆN CHO TỪ HIỆN TẠI
     ====================================================================== */
  function renderCurrent() {
    state.playToken++;
    const myToken = state.playToken;
    const item = FLAT[state.flatIndex];
    const { onset, rime } = splitForDisplay(item.word);

    // ---- Header ----
    el.letter.textContent = item.key;
    el.letter.classList.remove('pop');
    void el.letter.offsetWidth; // reflow để animation chạy lại
    el.letter.classList.add('pop');
    el.wholeWordCaption.textContent = item.word;

    // ---- Footer ----
    el.keyPos.textContent = item.keyIndex + 1;
    el.wordPos.textContent = `từ ${item.wordIndexInKey + 1}/${item.totalWordsInKey}`;
    const prevKey = KEYS[item.keyIndex - 1];
    const nextKey = KEYS[item.keyIndex + 1];
    el.prevKeyLabel.textContent = prevKey || '—';
    el.nextKeyLabel.textContent = nextKey || '—';
    el.prevKeyBtn.disabled = !prevKey;
    el.nextKeyBtn.disabled = !nextKey;

    // ---- Ô Phần đầu / Phần cuối ----
    el.onsetCell.classList.remove('visible');
    el.rimeCell.classList.remove('visible');
    el.mergeCell.classList.add('hidden');
    el.mergeCell.classList.remove('visible');
    el.mergeCell.classList.remove('final-glow');
    clearLit(el.onsetText);
    clearLit(el.rimeText);

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

    // fade-in mượt: đợi 1 khung hình để transition CSS bắt được thay đổi
    requestAnimationFrame(() => {
      if (onset) el.onsetCell.classList.add('visible');
      el.rimeCell.classList.add('visible');
    });

    playWord(item, myToken);
  }

  /* ======================================================================
     10. ĐIỀU HƯỚNG
     ====================================================================== */
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

  el.prevKeyBtn.addEventListener('click', () => {
    stopAutoPlay();
    const item = FLAT[state.flatIndex];
    const prevKey = KEYS[item.keyIndex - 1];
    if (prevKey) goTo(KEY_FIRST_FLAT_INDEX[prevKey]);
  });
  el.nextKeyBtn.addEventListener('click', () => {
    stopAutoPlay();
    const item = FLAT[state.flatIndex];
    const nextKey = KEYS[item.keyIndex + 1];
    if (nextKey) goTo(KEY_FIRST_FLAT_INDEX[nextKey]);
  });

  el.replayBtn.addEventListener('click', () => {
    stopAutoPlay();
    state.playToken++;
    const myToken = state.playToken;
    playWord(FLAT[state.flatIndex], myToken);
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowRight' || e.key === 'PageDown') { e.preventDefault(); stopAutoPlay(); next(); }
    else if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); stopAutoPlay(); prev(); }
  });

  el.rateSlider.addEventListener('input', () => {
    state.rate = parseFloat(el.rateSlider.value);
    el.rateValue.textContent = state.rate.toFixed(1) + '×';
  });

  if (el.autoPlayToggle) {
    el.autoPlayToggle.addEventListener('change', () => {
      state.autoPlay = el.autoPlayToggle.checked;
      if (!state.autoPlay && state.autoTimer) {
        clearTimeout(state.autoTimer);
        state.autoTimer = null;
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
      el.wholeWordCaption.textContent =
        'Không tải được ' + DATA_URL + ' — hãy chạy trang qua local server thay vì mở trực tiếp file.';
      return;
    }

    const { keys, flat, firstIndex } = flattenData(DATA);
    KEYS = keys;
    FLAT = flat;
    KEY_FIRST_FLAT_INDEX = firstIndex;

    if (FLAT.length === 0) {
      el.letter.textContent = '!';
      el.wholeWordCaption.textContent = 'data.json không có dữ liệu nào.';
      return;
    }

    el.keyTotal.textContent = KEYS.length;
    renderCurrent();
  }

  init();

})();