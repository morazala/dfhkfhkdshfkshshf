'use strict';

const { canonicalAudioText, isLegacyParserText, splitOnsetRime, stripTone } = require('./phonics-parser.js');

// Danh mục model/voice được phép chọn trong UI và trong generator.
// Đây chỉ là metadata; không có request TTS nào được thực hiện tại đây.
const DEFAULT_ROUTE = Object.freeze({ model: 'FPT.AI-VITs', voice: 'std_leminh' });
const TTS_CATALOG = Object.freeze([
  { id: 'std_leminh', model: 'FPT.AI-VITs', voice: 'std_leminh', label: 'Lê Minh · Nam · Bắc' },
  { id: 'std_kimngan', model: 'FPT.AI-VITs', voice: 'std_kimngan', label: 'Kim Ngân · Nữ · Nam' },
  { id: 'std_banmai', model: 'FPT.AI-VITs', voice: 'std_banmai', label: 'Ban Mai · Nữ · Bắc' },
  { id: 'std_hatieumai', model: 'FPT.AI-VITs', voice: 'std_hatieumai', label: 'Hà Tiểu Mai · Nữ · Nam' },
  { id: 'std_ngoclam', model: 'FPT.AI-VITs', voice: 'std_ngoclam', label: 'Ngọc Lam · Nữ · Trung' },
  { id: 'std_thuminh', model: 'FPT.AI-VITs', voice: 'std_thuminh', label: 'Thu Minh · Nữ · Bắc' },
  { id: 'std_giahuy', model: 'FPT.AI-VITs', voice: 'std_giahuy', label: 'Gia Huy · Nam · Nam' },
  { id: 'std_huyphong', model: 'FPT.AI-VITs', voice: 'std_huyphong', label: 'Huy Phong · Nam · Bắc' },
  { id: 'std_minhquan', model: 'FPT.AI-VITs', voice: 'std_minhquan', label: 'Minh Quân · Nam · Bắc' }
]);

function normalizeCatalog(input) {
  const source = Array.isArray(input) ? input : TTS_CATALOG;
  const seen = new Set();
  const catalog = [];
  for (const item of source) {
    const model = String(item?.model || '').trim();
    const voice = String(item?.voice || item?.id || '').trim();
    const label = String(item?.label || `${model} · ${voice}`).trim();
    if (!model || !voice || !/^[\w.-]+$/.test(model) || !/^[\w.-]+$/.test(voice)) continue;
    const key = `${model}::${voice}`;
    if (seen.has(key)) continue;
    seen.add(key);
    catalog.push({ id: voice, model, voice, label: label || key });
  }
  return catalog.length ? catalog : TTS_CATALOG.map(item => ({ ...item }));
}

function normalizeText(text) {
  return String(text || '').normalize('NFC').trim().replace(/\s+/g, ' ');
}

function normalizeRoute(route, catalog = TTS_CATALOG) {
  const model = String(route?.model || '').trim();
  const voice = String(route?.voice || '').trim();
  const allowed = new Set(normalizeCatalog(catalog).map(item => `${item.model}::${item.voice}`));
  if (!allowed.has(`${model}::${voice}`)) return null;
  return { model, voice };
}

const TONE_NAMES = Object.freeze(['ngang', 'huyền', 'sắc', 'hỏi', 'ngã', 'nặng']);

function normalizePrefix(prefix) {
  return normalizeText(prefix).toLowerCase();
}

function normalizeExcludedTones(input) {
  const values = Array.isArray(input) ? input : [];
  const indexes = [];
  for (const value of values) {
    const index = typeof value === 'number'
      ? value
      : TONE_NAMES.indexOf(normalizeText(value).toLowerCase());
    if (Number.isInteger(index) && index >= 1 && index <= 5 && !indexes.includes(index)) indexes.push(index);
  }
  return indexes.sort((a, b) => a - b);
}

function normalizePrefixRoute(rule, catalog = TTS_CATALOG) {
  const route = normalizeRoute(rule, catalog);
  if (!route) return null;
  return { ...route, excludeTones: normalizeExcludedTones(rule?.excludeTones) };
}

function getConsonantPrefix(text) {
  return normalizePrefix(splitOnsetRime(normalizeText(text)).onset);
}

function getPrefixRouteForText(config, text) {
  const prefix = getConsonantPrefix(text);
  const rule = config?.prefixRoutes?.[prefix];
  if (!rule) return null;
  const toneIndex = stripTone(normalizeText(text)).toneIndex;
  return rule.excludeTones?.includes(toneIndex) ? null : rule;
}

function normalizeRoutesConfig(input, catalog = TTS_CATALOG) {
  const normalizedCatalog = normalizeCatalog(catalog);
  const defaultRoute = normalizeRoute(input?.default, normalizedCatalog) || {
    model: normalizedCatalog[0].model,
    voice: normalizedCatalog[0].voice
  };
  const routes = {};
  if (input?.routes && typeof input.routes === 'object' && !Array.isArray(input.routes)) {
    for (const [rawText, rawRoute] of Object.entries(input.routes)) {
      const normalizedRawText = normalizeText(rawText);
      const text = canonicalAudioText(normalizedRawText);
      const route = normalizeRoute(rawRoute, normalizedCatalog);
      if (!text || !route) continue;
      // Nếu file cũ có cả "o" và "o.", key chính thức "o." thắng alias
      // bất kể thứ tự trong JSON. Điều này tránh route bị chọn không ổn định.
      if (normalizedRawText !== text && routes[text]) continue;
      routes[text] = route;
    }
  }
  const prefixRoutes = {};
  if (input?.prefixRoutes && typeof input.prefixRoutes === 'object' && !Array.isArray(input.prefixRoutes)) {
    for (const [rawPrefix, rawRule] of Object.entries(input.prefixRoutes)) {
      const prefix = normalizePrefix(rawPrefix);
      const rule = normalizePrefixRoute(rawRule, normalizedCatalog);
      if (!prefix || !rule) continue;
      // Alleen een prefix die de parser als medeklinker aan het begin herkent
      // mag een prefix-route worden; een regel voor "a" zou alle klinkers
      // onbedoeld kunnen nuanceren.
      if (getConsonantPrefix(prefix) !== prefix) continue;
      prefixRoutes[prefix] = rule;
    }
  }
  return { schemaVersion: 1, default: defaultRoute, routes, prefixRoutes };
}

function routeKey(route) {
  return `${route.model}::${route.voice}`;
}

function getRouteForText(config, text) {
  const normalized = canonicalAudioText(text);
  const routes = config?.routes || {};
  return routes[normalized] || getPrefixRouteForText(config, normalized) || config?.default || DEFAULT_ROUTE;
}

module.exports = {
  DEFAULT_ROUTE,
  TTS_CATALOG,
  normalizeCatalog,
  normalizeText,
  canonicalAudioText,
  isLegacyParserText,
  normalizeRoute,
  normalizePrefix,
  normalizeExcludedTones,
  normalizePrefixRoute,
  getConsonantPrefix,
  getPrefixRouteForText,
  normalizeRoutesConfig,
  routeKey,
  getRouteForText
};
