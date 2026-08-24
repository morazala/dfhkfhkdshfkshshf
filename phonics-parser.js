// phonics-parser.js
// Module thuần JS (không phụ thuộc thư viện ngoài) - phân tích 1 từ tiếng Việt
// thành trình tự các bước đánh vần để hiển thị / đọc bằng TTS.
//
// Cách dùng:
//   const { buildSpellingSteps } = require('./phonics-parser.js'); // Node
//   hoặc <script src="phonics-parser.js"></script> rồi dùng window.PhonicsParser
//
//   const result = buildSpellingSteps('khoẻ');
//   console.log(result.steps);
//   // [{type:'letter',text:'o'}, {type:'letter',text:'e'}, {type:'combine',text:'oe'},
//   //  {type:'token',text:'khờ'}, {type:'combine',text:'oe'}, {type:'combine',text:'khoe'},
//   //  {type:'tone',text:'hỏi'}, {type:'final',text:'khoẻ'}]
//
// GHI CHÚ BẢN CẬP NHẬT NÀY:
// 1) Sửa lỗi lặp bước "combine/final" khi từ không mang dấu thanh (dấu ngang).
//    Trước đây "ba" -> bờ - a - ba - ba (4 bước, lặp "ba"). Nay -> bờ - a - ba (3 bước).
//    Lưu ý: với ÂM CUỐI TẮC (c/ch/p/t) có dấu mặc định (sắc) thì bước ghép vần & bước
//    cuối cùng NGANG NHIÊN có thể trùng chữ (vd "giết" xuất hiện 2 lần) - đây là hành vi
//    ĐÚNG theo sư phạm (nhắc lại dấu sắc), không phải lỗi, nên KHÔNG bị gộp.
// 2) Viết lại hoàn toàn logic tách & đánh vần cho phụ âm đầu "gi" và "g", theo đúng
//    6 trường hợp chuẩn sư phạm tiểu học (xem hàm buildGiSteps bên dưới).
// 3) Thêm bảng TÊN CHỮ CÁI cho "ă" (đọc/hiện là "á") và "â" (đọc/hiện là "ớ") khi hiển
//    thị bước {type:'letter', ...}.
// 4) Viết lại xử lý "q"/"qu": khi vần đi sau "qu" là vần ĐƠN GIẢN (không có âm cuối
//    và phần nguyên âm sau "u" chỉ có 1 chữ cái, vd "qua", "quê", "quy") thì GHÉP
//    TRỰC TIẾP theo đúng tinh thần "gi" (gi -> a -> gia): cùa -> a -> qua, KHÔNG
//    tách rời "u" và nguyên âm sau nó thành 2 bước đánh vần rời rạc. Khi vần sau
//    "qu" PHỨC TẠP hơn (có âm cuối, hoặc phần nguyên âm sau "u" có từ 2 chữ cái trở
//    lên, vd "quýt" = u+y+t, "quan" = u+a+n) thì vẫn giữ nguyên thuật toán tách vần
//    đầy đủ như trước (xem buildQuSteps bên dưới).
// 5) Thêm xử lý âm "y" cho TTS: chữ "y" khi đứng MỘT MÌNH trong 1 bước {type:'letter'}
//    (không dính liền với nguyên âm khác trong cùng 1 chuỗi text, vd bước letter "y"
//    tách riêng trong "hay", "yêu", hay bước letter "y" của "quy") sẽ có thêm trường
//    audioText:'i' để TTS đọc đúng (bản thân "text" hiển thị vẫn là "y" cho UI).
//    Các cụm vần đã ghép sẵn trong 1 chuỗi (vd "uy", "uýt", "uyệt") giữ nguyên "y",
//    KHÔNG tráo, vì TTS đã đọc đúng các cụm này.

(function (global) {
  'use strict';

  // ---------- 1. BẢNG TOKEN ÂM ĐẦU (dùng khi API đọc phần đầu) ----------
  const ONSET_TOKENS = {
    'ngh': 'ngờ', 'ng': 'ngờ', 'nh': 'nhờ', 'ch': 'chờ', 'tr': 'trờ',
    'th': 'thờ', 'ph': 'phờ', 'kh': 'khờ', 'gh': 'gờ',
    'b': 'bờ', 'c': 'cờ', 'd': 'dờ', 'đ': 'đờ', 'g': 'gờ', 'h': 'hờ',
    'k': 'ca', 'l': 'lờ', 'm': 'mờ', 'n': 'nờ', 'p': 'pờ', 'q': 'cùa',
    'r': 'rờ', 's': 'sờ', 't': 'tờ', 'v': 'vờ', 'x': 'xờ',
    'gi': 'gi'
  };
  // thứ tự so khớp âm đầu: DÀI TRƯỚC NGẮN.
  // "gi" KHÔNG nằm trong danh sách này nữa: "gi" được nhận diện và xử lý riêng
  // (xem buildGiSteps) TRƯỚC KHI rơi vào splitOnsetRime, vì cách tách chữ của "gi"
  // phụ thuộc vào vần đi sau nó (vần đơn / vần phức / vần bị nuốt "i") chứ không phải
  // một quy tắc tách tiền tố cố định như các phụ âm đầu khác.
  const ONSET_ORDER = [
    'ngh', 'ng', 'nh', 'ch', 'tr', 'th', 'ph', 'kh', 'gh',
    'b', 'c', 'd', 'đ', 'g', 'h', 'k', 'l', 'm', 'n', 'p', 'q', 'r', 's', 't', 'v', 'x'
  ];

  // ---------- 2. BẢNG TOKEN PHỤ ÂM CUỐI (8 âm cuối hợp lệ trong tiếng Việt) ----------
  const FINAL_TOKENS = { 'ng': 'ngờ', 'nh': 'nhờ', 'ch': 'chờ', 'c': 'cờ', 'm': 'mờ', 'n': 'nờ', 'p': 'pờ', 't': 'tờ' };
  const FINAL_ORDER = ['ng', 'nh', 'ch', 'c', 'm', 'n', 'p', 't'];
  const STOP_FINALS = new Set(['c', 'ch', 'p', 't']); // âm cuối tắc -> chỉ nhận dấu sắc/nặng

  // ---------- 3. BẢNG DẤU THANH ----------
  const TONE_TABLE = {
    a: ['a', 'à', 'á', 'ả', 'ã', 'ạ'], ă: ['ă', 'ằ', 'ắ', 'ẳ', 'ẵ', 'ặ'],
    â: ['â', 'ầ', 'ấ', 'ẩ', 'ẫ', 'ậ'], e: ['e', 'è', 'é', 'ẻ', 'ẽ', 'ẹ'],
    ê: ['ê', 'ề', 'ế', 'ể', 'ễ', 'ệ'], i: ['i', 'ì', 'í', 'ỉ', 'ĩ', 'ị'],
    o: ['o', 'ò', 'ó', 'ỏ', 'õ', 'ọ'], ô: ['ô', 'ồ', 'ố', 'ổ', 'ỗ', 'ộ'],
    ơ: ['ơ', 'ờ', 'ớ', 'ở', 'ỡ', 'ợ'], u: ['u', 'ù', 'ú', 'ủ', 'ũ', 'ụ'],
    ư: ['ư', 'ừ', 'ứ', 'ử', 'ữ', 'ự'], y: ['y', 'ỳ', 'ý', 'ỷ', 'ỹ', 'ỵ']
  };
  const TONE_NAMES = ['ngang', 'huyền', 'sắc', 'hỏi', 'ngã', 'nặng'];
  const CHAR_TO_BASE_TONE = {};
  Object.keys(TONE_TABLE).forEach(base => {
    TONE_TABLE[base].forEach((ch, idx) => { CHAR_TO_BASE_TONE[ch] = { base, toneIndex: idx }; });
  });
  const VOWEL_BASES = new Set(Object.keys(TONE_TABLE));
  // nguyên âm có dấu phụ sẵn -> luôn ưu tiên nhận dấu thanh khi ghép
  const PRIORITY_VOWELS = ['â', 'ă', 'ê', 'ô', 'ơ', 'ư'];

  // ---------- 3b. TÊN CHỮ CÁI (dùng khi hiển thị bước {type:'letter'}) ----------
  // "ă" đọc tên là "á", "â" đọc tên là "ớ" theo quy ước phổ thông tiểu học.
  // Các nguyên âm khác giữ nguyên chữ viết làm tên.
  const LETTER_NAMES = { 'ă': 'á', 'â': 'ớ' };
  function letterName(ch) { return LETTER_NAMES[ch] || ch; }

  // Tạo 1 bước {type:'letter', ...} cho MỘT chữ cái đứng riêng lẻ. Khi chữ cái đó là
  // "y" đứng MỘT MÌNH (mỗi ký tự được tách ra thành 1 bước letter riêng, chưa ghép
  // chung với nguyên âm khác trong cùng 1 chuỗi), tráo trực tiếp hiển thị thành "i"
  // (đọc là "i ngắn") để TTS đọc đúng. Các chuỗi đã ghép nhiều ký tự lại với nhau
  // (vd bước combine "uy", "uýt", "ay", "uay", hay chính từ hoàn chỉnh) KHÔNG đi qua
  // hàm này nên "y" trong các chuỗi đó vẫn được giữ nguyên như cũ.
  // FPT.AI-VITs đôi lúc hiểu nguyên âm đơn "o", "ô", "ư" như một mảnh âm tiết
  // khi đầu vào chỉ có đúng một ký tự. Dấu chấm không được hiển thị, nhưng giúp
  // engine chốt đây là một lượt đọc độc lập. Generator sẽ cache theo audioText.
  const ISOLATED_VOWEL_AUDIO_TEXT = { o: 'o.', ô: 'ô.', ư: 'ư.' };

  function letterStep(ch) {
    const text = ch === 'y' ? 'i' : letterName(ch);
    const audioText = ISOLATED_VOWEL_AUDIO_TEXT[text];
    return audioText ? { type: 'letter', text, audioText } : { type: 'letter', text };
  }

  // ---------- 1b. GHI ĐÈ VĂN BẢN ĐỌC (TTS) CHO TỪNG TOKEN ÂM ----------
  // "s" và "x" trong tiếng Việt CHUẨN/phổ thông (giọng Bắc) phát âm GIỐNG HỆT
  // NHAU (đều là /s/ xát vô thanh, KHÔNG uốn lưỡi) — chỉ giọng miền Nam/Trung mới
  // phát âm "s" uốn lưỡi khác "x". Đây LÀ PHÁT ÂM ĐÚNG chuẩn phổ thông, không phải
  // lỗi — giọng cục bộ vẫn giữ đúng khác biệt phát âm ở mức văn bản học tập,
  // CẢ HAI đều là giọng chuẩn/Bắc, chưa có giọng miền Nam để tạo ra sự khác biệt
  // uốn lưỡi mà bạn muốn. Không có cách nào ở tầng code sửa được việc này — cần
  // Microsoft ra thêm giọng miền Nam mới có.
  //
  // Việc CÒN SỬA ĐƯỢC: nếu 2 âm tiết ngắn này bị đọc lí nhí/cụt (không chỉ "giống
  // nhau" mà còn khó nghe rõ) khi bị đọc tách biệt khỏi câu, có thể cải thiện NGỮ
  // ĐIỆU đọc (không đổi được ÂM VỊ). Bảng dưới đây cho phép đổi riêng VĂN BẢN GỬI
  // CHO TTS của một token mà không ảnh hưởng gì tới chữ hiển thị trên UI (bước
  // {type:'token'} vốn không hiển thị lên ô nào, chỉ dùng để đọc — xem playWord
  // trong script.js). Đang thử thêm dấu chấm cuối để TTS đọc trọn âm, rõ ràng như
  // 1 câu hoàn chỉnh thay vì bị cụt như khi đọc lửng giữa chừng. Nếu vẫn chưa đủ
  // rõ, có thể thử bọc SSML (vd '<prosody rate="-15%">Sờ.</prosody>') — NHƯNG chỉ
  // có tác dụng nếu engine TTS hỗ trợ SSML; engine trình duyệt hiện tại không
  // gửi SSML nên các override văn bản ở trên vẫn là cách an toàn nhất.
  const TOKEN_AUDIO_OVERRIDES = {
    'sờ': 'Sờ.',
    'xờ': 'Xờ.'
  };
  function tokenAudioText(name) { return TOKEN_AUDIO_OVERRIDES[name] || name; }

  // ---------- HÀM TIỆN ÍCH ----------
  function chars(str) { return Array.from(str); }
  function charBaseTone(ch) { return CHAR_TO_BASE_TONE[ch] || { base: ch, toneIndex: 0 }; }

  function stripTone(str) {
    let toneIndex = 0;
    const base = chars(str).map(ch => {
      const info = charBaseTone(ch);
      if (info.toneIndex !== 0) toneIndex = info.toneIndex; // tiếng Việt chỉ có 1 dấu thanh / âm tiết
      return info.base;
    }).join('');
    return { base, toneIndex, toneName: TONE_NAMES[toneIndex] };
  }

  // gắn dấu thanh vào 1 nhân âm: ưu tiên nguyên âm có dấu phụ, nếu không có thì đặt ở
  // nguyên âm CUỐI CÙNG (đúng cho âm tiết có phụ âm cuối / âm tiết đóng - xem ghi chú cuối file)
  function applyTone(nucleus, toneIndex) {
    if (toneIndex === 0) return nucleus;
    const arr = chars(nucleus);
    // Với cụm "ươ", dấu đặt trên "ơ" (ướp/ước), không đặt trên "ư".
    // Đây là trường hợp đặc biệt của quy tắc đặt dấu tiếng Việt.
    let idx = arr.includes('ư') && arr.includes('ơ')
      ? arr.lastIndexOf('ơ')
      : arr.findIndex(c => PRIORITY_VOWELS.includes(c));
    if (idx === -1) idx = arr.length - 1;
    const base = arr[idx];
    arr[idx] = (TONE_TABLE[base] || [base])[toneIndex] || base;
    return arr.join('');
  }

  function tonelessWord(word) { return chars(word).map(ch => charBaseTone(ch).base).join(''); }

  // Một số vần đóng không thể đứng thanh ngang trong chính tả tiếng Việt:
  // op/oc/ôt... khi parser nhận đầu vào không dấu sẽ dùng dạng đọc mặc định
  // sắc (óp/óc/ốt...). Đây là canonical key của AUDIO CACHE, không phải một
  // bước mới để hiển thị hay đọc thêm dấu. Vì vậy op và óp dùng chung một cache.
  function canonicalAudioText(text) {
    const normalized = String(text || '').normalize('NFC').trim().replace(/\s+/g, ' ');
    if (!normalized) return '';
    if ({ o: true, 'ô': true, 'ư': true }[normalized]) return `${normalized}.`;
    const { onset, rime } = splitOnsetRime(normalized);
    if (onset) return normalized;
    const { base, toneIndex } = stripTone(rime);
    const { nucleus, final } = splitNucleusFinal(base);
    if (toneIndex === 0 && STOP_FINALS.has(final)) return applyTone(nucleus, 2) + final;
    return normalized;
  }

  function isLegacyParserText(text) {
    return String(text || '').normalize('NFC').includes('ứơ');
  }

  // ---------- 4. TÁCH ÂM ĐẦU / VẦN (dùng cho MỌI phụ âm đầu TRỪ "gi") ----------
  function splitOnsetRime(word) {
    const plain = tonelessWord(word).toLowerCase();
    let onsetLen = 0;
    for (const pat of ONSET_ORDER) {
      if (plain.startsWith(pat)) { onsetLen = pat.length; break; }
    }
    const wordChars = chars(word);
    const onset = wordChars.slice(0, onsetLen).join('');
    const rime = wordChars.slice(onsetLen).join('');
    const onsetToken = onset ? ONSET_TOKENS[tonelessWord(onset).toLowerCase()] : '';
    return { onset, rime, onsetToken };
  }

  // ---------- 5. TÁCH NHÂN ÂM / PHỤ ÂM CUỐI (đầu vào đã bỏ dấu thanh) ----------
  function splitNucleusFinal(rimeToneless) {
    for (const pat of FINAL_ORDER) {
      if (rimeToneless.endsWith(pat) && rimeToneless.length > pat.length) {
        return { nucleus: rimeToneless.slice(0, -pat.length), final: pat };
      }
    }
    return { nucleus: rimeToneless, final: '' };
  }

  // ---------- 6. THUẬT TOÁN ĐÁNH VẦN DÙNG CHUNG ----------
  // Dùng cho mọi phụ âm đầu thường (b, c, ..., g) VÀ cho 2 trường hợp "gi + vần
  // không bị nuốt i" (vần đơn / vần phức, xem buildGiSteps trường hợp 1 & 2), khi đó
  // onset truyền vào sẽ là "gi" (2 ký tự) và onsetToken là 'gi'.
  function runStandard(word, onset, rime, onsetToken) {
    const { toneIndex, toneName } = stripTone(rime);
    const rimeToneless = stripTone(rime).base;
    const { nucleus, final } = splitNucleusFinal(rimeToneless);
    const isChecked = STOP_FINALS.has(final);
    const defaultToneIndex = isChecked ? 2 /* sắc */ : 0 /* ngang */;
    const needsRimeSpelling = final !== '' || chars(nucleus).length > 1;

    const steps = [];
    let rimeDisplay;

    // Phụ âm đứng một mình (b, c, m...) chỉ là một âm đầu độc lập. Không tạo
    // bước vần/từ hoàn chỉnh vì TTS sẽ cố đọc lại chữ như một âm tiết (cê, bê...).
    if (onset && !rime) {
      return {
        word, onset, rime, nucleus, final, toneName,
        steps: [{ type: 'token', text: tokenAudioText(onsetToken) }]
      };
    }

    if (needsRimeSpelling) {
      chars(nucleus).forEach(ch => steps.push(letterStep(ch)));
      if (final) steps.push({ type: 'token', text: tokenAudioText(FINAL_TOKENS[final]) });

      const defaultRime = (isChecked ? applyTone(nucleus, defaultToneIndex) : nucleus) + final;
      steps.push({ type: 'combine', text: defaultRime });
      // Dấu thanh CHỈ được gắn ở bước cuối cùng (sau khi ghép xong âm đầu + vần gốc),
      // nên KHÔNG chèn thêm bước tone/combine trung gian ở đây nữa, kể cả khi thanh
      // thực tế khác thanh mặc định của âm cuối tắc (vd "quỵt" vẫn ghép qua "uýt").
      rimeDisplay = defaultRime;
    } else {
      rimeDisplay = nucleus; // nguyên âm đơn, không phụ âm cuối
    }

    if (onset) {
      steps.push({ type: 'token', text: tokenAudioText(onsetToken) });
      if (!needsRimeSpelling && nucleus) steps.push(letterStep(nucleus));
      else if (needsRimeSpelling) steps.push({ type: 'combine', text: rimeDisplay }); // nhắc lại vần trước khi ghép

      const onsetBase = tonelessWord(onset).toLowerCase();
      steps.push({ type: 'combine', text: onsetBase + rimeDisplay });
    } else if (!needsRimeSpelling) {
      // KHÔNG có phụ âm đầu và vần chỉ là 1 nguyên âm đơn (vd "o", "ò", "ó"...).
      // Trước đây bước letter chỉ được đẩy vào bên trong nhánh if(onset) nên các từ
      // dạng này bị "nuốt" mất bước đọc nguyên âm gốc, khiến "ò" chỉ đọc "huyền -> ò"
      // mà bỏ qua "o". Nay luôn phát âm nguyên âm gốc trước khi ghép dấu thanh.
      steps.push(letterStep(nucleus));
    }

    // Với vần không có âm đầu và âm cuối tắc ở thanh ngang (ac, ăc, âc,
    // at, ap...), defaultRime (ác/ắc/ấc...) đã là bước cuối của phần vần.
    // Không thêm lại từ gốc không dấu vì sẽ khiến TTS đọc dư một lượt (ác -> ac).
    if (!onset && isChecked && toneIndex === 0 && steps.at(-1)?.type === 'combine') {
      steps.at(-1).type = 'final';
      return { word, onset, rime, nucleus, final, toneName, steps };
    }

    // ---- Bước dấu thanh + từ hoàn chỉnh ----
    // Nếu từ CÓ dấu thanh: luôn hiện rõ tên dấu rồi tới từ hoàn chỉnh (kể cả khi trùng
    // chữ với bước ghép ngay trước, vì đó là phần nhắc "âm cuối tắc mặc định là sắc").
    // Nếu từ KHÔNG có dấu thanh (dấu ngang): không lặp lại y hệt bước ghép cuối cùng
    // nữa, chỉ đổi type của bước đó thành 'final'.
    if (toneIndex !== 0) {
      steps.push({ type: 'tone', text: toneName });
      steps.push({ type: 'final', text: word });
    } else if (steps.length && steps[steps.length - 1].text === word) {
      steps[steps.length - 1].type = 'final';
    } else {
      steps.push({ type: 'final', text: word });
    }

    return { word, onset, rime, nucleus, final, toneName, steps };
  }

  // ---------- 7. XỬ LÝ RIÊNG CHO PHỤ ÂM ĐẦU "gi" ----------
  // 6 trường hợp chuẩn sư phạm tiểu học:
  //  T3: "gi" đứng một mình + dấu thanh (vd "gì", "gí")
  //  T1: "gi" + vần đơn (1 nguyên âm, vd "giá", "gió")
  //  T2: "gi" + vần phức không bị nuốt i (vd "giăng", "giáo")
  //  T4: "gi" + vần bị nuốt i, vần ẩn không có nhân "ê" (vd "gìn" <- "in")
  //  T5: "gi" + vần bị nuốt i, vần ẩn có nhân "ê" (vd "giết" <- "iêt", "giếng" <- "iêng")
  function buildGiSteps(word) {
    const wordChars = chars(word);
    const tonelessAll = tonelessWord(word).toLowerCase();
    const remainingToneless = tonelessAll.slice(2);
    const whole = stripTone(word);
    const toneIndex = whole.toneIndex;
    const toneName = whole.toneName;

    // ---- Trường hợp 3: "gi" đơn (chỉ 2 ký tự gi + dấu thanh, không còn vần nào khác) ----
    if (remainingToneless === '') {
      const steps = [{ type: 'token', text: tokenAudioText('gi') }];
      if (toneIndex !== 0) {
        steps.push({ type: 'tone', text: toneName });
        steps.push({ type: 'final', text: word });
      }
      return { word, onset: 'gi', rime: '', nucleus: '', final: '', toneName, steps };
    }

    const firstRemBase = remainingToneless.charAt(0);
    const isConsonantStart = !VOWEL_BASES.has(firstRemBase);
    const needsRestore = isConsonantStart || firstRemBase === 'ê';

    // ---- Trường hợp 1 & 2: KHÔNG bị nuốt "i" -> dùng thuật toán chuẩn, onset = "gi" ----
    if (!needsRestore) {
      const onset = wordChars.slice(0, 2).join('');
      const rime = wordChars.slice(2).join('');
      return runStandard(word, onset, rime, 'gi');
    }

    // ---- Trường hợp 4 & 5: bị nuốt "i" -> khôi phục nguyên âm "i" ẩn đầu vần ----
    const hiddenRimeToneless = 'i' + remainingToneless;
    const { nucleus, final } = splitNucleusFinal(hiddenRimeToneless);
    const isChecked = STOP_FINALS.has(final);
    const defaultToneIndex = isChecked ? 2 : 0;

    const steps = [];
    chars(nucleus).forEach(ch => steps.push(letterStep(ch)));
    if (final) steps.push({ type: 'token', text: tokenAudioText(FINAL_TOKENS[final]) });

    const defaultRime = (isChecked ? applyTone(nucleus, defaultToneIndex) : nucleus) + final;
    steps.push({ type: 'combine', text: defaultRime });
    // Cũng như runStandard: không chèn bước tone/combine trung gian, dấu thanh chỉ
    // xuất hiện ở bước cuối cùng.
    const rimeDisplay = defaultRime;

    steps.push({ type: 'token', text: tokenAudioText('gi') });
    steps.push({ type: 'combine', text: rimeDisplay }); // nhắc lại vần ẩn trước khi ghép

    // Chữ "i" đầu vần ẩn CHÍNH LÀ chữ "i" đã viết ngay sau "g" (bị dùng chung / nuốt),
    // nên khi ghép chữ thật chỉ cần thêm 1 chữ "g", KHÔNG lặp lại "gi" + rime.
    const merged = 'g' + rimeDisplay;
    steps.push({ type: 'combine', text: merged });

    if (toneIndex !== 0) {
      steps.push({ type: 'tone', text: toneName });
      steps.push({ type: 'final', text: word });
    } else if (steps.length && steps[steps.length - 1].text === word) {
      steps[steps.length - 1].type = 'final';
    } else {
      steps.push({ type: 'final', text: word });
    }

    return { word, onset: 'gi', rime: hiddenRimeToneless, nucleus, final, toneName, steps };
  }

  // ---------- 7b. XỬ LÝ RIÊNG CHO PHỤ ÂM ĐẦU "qu" ----------
  // "q" trong tiếng Việt luôn đi kèm "u" (đọc gộp là "cùa"). Chữ "u" đó KHÔNG phải là
  // một nguyên âm cần đánh vần riêng khi phần vần còn lại chỉ có 1 nguyên âm và không
  // có âm cuối (vd "qua", "quê", "quy") - những trường hợp này ghép trực tiếp giống
  // hệt "gi" + vần đơn: cùa -> a -> qua. Khi vần phức tạp hơn (có âm cuối như "quýt",
  // hoặc phần sau "u" có từ 2 chữ cái trở lên như "quan"/"quay") thì vẫn tách vần đầy
  // đủ theo thuật toán chuẩn (runStandard), giữ nguyên hành vi trước đây cho các từ đó.
  function buildQuSteps(word) {
    const wordChars = chars(word);
    // onset chỉ gồm chữ "q" (1 ký tự); rime là phần còn lại, LUÔN bắt đầu bằng "u".
    const onset = wordChars.slice(0, 1).join('');
    const rime = wordChars.slice(1).join('');
    const rimeToneless = stripTone(rime).base;
    const { nucleus, final } = splitNucleusFinal(rimeToneless);

    // Vần "đơn giản": không có âm cuối, và phần nguyên âm SAU "u" chỉ có tối đa 1 chữ.
    const isSimple = final === '' && chars(nucleus).length <= 2;

    if (!isSimple) {
      // Vần phức tạp -> giữ nguyên thuật toán tách vần đầy đủ như trước giờ.
      return runStandard(word, onset, rime, 'cùa');
    }

    const { toneIndex, toneName } = stripTone(rime);
    const extra = chars(nucleus).slice(1).join(''); // nguyên âm đứng sau "u", vd "a","y","ê"

    const steps = [{ type: 'token', text: tokenAudioText('cùa') }];
    if (extra) steps.push(letterStep(extra));

    const merged = 'qu' + extra; // vd "qua", "quy", "quê" (chưa có dấu thanh)
    steps.push({ type: 'combine', text: merged });

    if (toneIndex !== 0) {
      steps.push({ type: 'tone', text: toneName });
      steps.push({ type: 'final', text: word });
    } else if (steps.length && steps[steps.length - 1].text === word) {
      steps[steps.length - 1].type = 'final';
    } else {
      steps.push({ type: 'final', text: word });
    }

    return { word, onset: 'qu', rime: nucleus, nucleus, final: '', toneName, steps };
  }

  // ---------- 8. HÀM CHÍNH ----------
  function buildSpellingSteps(word) {
    word = word.trim();
    const tonelessLower = tonelessWord(word).toLowerCase();

    // "gi" được xử lý riêng hoàn toàn TRƯỚC KHI chạy splitOnsetRime, vì cách tách
    // chữ phụ thuộc vào vần đi sau (xem buildGiSteps). Phụ âm đầu "g" đơn (không có
    // "i" theo sau, vd "gà", "gỗ" - Trường hợp 6) vẫn rơi vào nhánh chuẩn bên dưới,
    // dùng đúng token 'gờ' có sẵn trong ONSET_TOKENS, không cần chỉnh gì thêm.
    if (tonelessLower.startsWith('gi')) {
      return buildGiSteps(word);
    }

    // "qu" cũng được xử lý riêng TRƯỚC KHI chạy splitOnsetRime, vì onset chuẩn chỉ
    // nhận diện được "q" (1 ký tự) chứ không phải "qu" (2 ký tự) - xem buildQuSteps.
    if (tonelessLower.startsWith('qu')) {
      return buildQuSteps(word);
    }

    const { onset, rime, onsetToken } = splitOnsetRime(word);
    return runStandard(word, onset, rime, onsetToken);
  }

  const PhonicsParser = { buildSpellingSteps, canonicalAudioText, isLegacyParserText, stripTone, splitOnsetRime, splitNucleusFinal, applyTone };
  if (typeof module !== 'undefined' && module.exports) module.exports = PhonicsParser;
  else global.PhonicsParser = PhonicsParser;

})(typeof window !== 'undefined' ? window : globalThis);


// ============ TỰ KIỂM TRA (chạy: node phonics-parser.js) ============
if (typeof require !== 'undefined' && require.main === module) {
  const { buildSpellingSteps } = module.exports;
  const testWords = [
    'ba', 'bạn', 'khoẻ', 'quýt', 'quỵt', 'hai', 'hay', 'yêu', 'yếu',
    'gia', 'già', 'gì', 'gìn', 'ga', 'gà', 'gỗ',
    'giăng', 'giáo', 'giết', 'giếng', 'khuyệt', 'qua', 'quà', 'quê', 'quy', 'quý', 'quan', 'quay'
  ];
  testWords.forEach(w => {
    const r = buildSpellingSteps(w);
    const seq = r.steps.map(s => s.text).join(' -> ');
    console.log(w.padEnd(6), ':', seq);
  });
}
/**
 * EXAMPLE OUTPUT
ba     : bờ -> a -> ba
bạn    : a -> nờ -> an -> bờ -> an -> ban -> nặng -> bạn
khoẻ   : o -> e -> oe -> khờ -> oe -> khoe -> hỏi -> khoẻ
quýt   : u -> y -> tờ -> uýt -> cùa -> uýt -> quýt -> sắc -> quýt
quỵt   : u -> y -> tờ -> uýt -> cùa -> uýt -> quýt -> nặng -> quỵt
hai    : a -> i -> ai -> hờ -> ai -> hai
hay    : a -> y -> ay -> hờ -> ay -> hay
yêu    : y -> ê -> u -> yêu
yếu    : y -> ê -> u -> yêu -> sắc -> yếu
gia    : gi -> a -> gia
già    : gi -> a -> gia -> huyền -> già
gì     : gi -> huyền -> gì
gìn    : i -> nờ -> in -> gi -> in -> gin -> huyền -> gìn
ga     : gờ -> a -> ga
gà     : gờ -> a -> ga -> huyền -> gà
gỗ     : gờ -> ô -> gô -> ngã -> gỗ
giăng  : á -> ngờ -> ăng -> gi -> ăng -> giăng
giáo   : a -> o -> ao -> gi -> ao -> giao -> sắc -> giáo
giết   : i -> ê -> tờ -> iết -> gi -> iết -> giết -> sắc -> giết
giếng  : i -> ê -> ngờ -> iêng -> gi -> iêng -> giêng -> sắc -> giếng
khuyệt : u -> y -> ê -> tờ -> uyết -> khờ -> uyết -> khuyết -> nặng -> khuyệt
 * 
 */
