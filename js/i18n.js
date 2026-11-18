/* English source copy is the fallback. Catalog getters keep learning content
   reactive without changing effect IDs, saved boards, or user-supplied names. */
(function (TL) {
  'use strict';
  const translations = TL.es || {};
  const languageKey = 'tonelab-language';
  const supported = ['en', 'es'];
  function preferredLanguage(languages, saved) {
    if (supported.includes(saved)) return saved;
    return (languages || []).map(value => value.toLowerCase().split('-')[0]).find(value => supported.includes(value)) || 'en';
  }
  let saved;
  try { saved = localStorage.getItem(languageKey); } catch {}
  let language = preferredLanguage(navigator.languages?.length ? navigator.languages : [navigator.language || 'en'], saved);
  const originals = new Map(Object.entries(translations).map(([en, es]) => [es, en]));
  const english = value => originals.get(value) || value;
  function t(value) {
    if (language === 'en' || typeof value !== 'string') return value;
    if (Object.hasOwn(translations, value)) return translations[value];
    const trimmed = value.trim();
    if (Object.hasOwn(translations, trimmed)) return value.replace(trimmed, translations[trimmed]);
    // A generated graphic-EQ hint includes its band frequency.
    if (value.startsWith('Graphic EQ band at ')) return value.replace('Graphic EQ band at ', 'Banda de EQ gráfica en ');
    return value;
  }
  const catalogs = new WeakSet();
  function catalog(object, textArray = false) {
    if (!object || typeof object !== 'object' || catalogs.has(object)) return object;
    catalogs.add(object);
    for (const [key, value] of Object.entries(object)) {
      if (typeof value === 'string' && !['id', 'key', 'shape', 'type', 'kind', 'view'].includes(key) && !(key === 'name' && object.id) && (!Array.isArray(object) || textArray || /[A-Z\s]/.test(value))) {
        const source = english(value);
        if (Object.hasOwn(translations, source) || source.startsWith('Graphic EQ band at ')) {
          Object.defineProperty(object, key, { enumerable: true, configurable: true, get: () => t(source) });
        }
      } else if (value && typeof value === 'object') catalog(value);
    }
    return object;
  }
  // Remember only authored HTML copy; runtime renderers own their dynamic text.
  const staticText = [], staticAttributes = [];
  const attributes = ['aria-label', 'title', 'placeholder', 'alt'];
  function initializeStatic(root = document.body) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (node.parentElement.closest('script, style, svg')) continue;
      if (t(node.data) !== node.data || Object.hasOwn(translations, node.data.trim())) staticText.push({ node, source: node.data, last: node.data });
    }
    for (const node of root.querySelectorAll('*')) for (const attribute of attributes) {
      if (node.hasAttribute(attribute) && Object.hasOwn(translations, node.getAttribute(attribute))) staticAttributes.push({ node, attribute, source: node.getAttribute(attribute), last: node.getAttribute(attribute) });
    }
    const description = document.querySelector('meta[name="description"]');
    if (description) staticAttributes.push({ node: description, attribute: 'content', source: description.content, last: description.content });
    applyStatic();
  }
  function applyStatic() {
    document.documentElement.lang = language;
    for (const entry of staticText) if (entry.node.isConnected && entry.node.data === entry.last) entry.node.data = entry.last = t(entry.source);
    for (const entry of staticAttributes) if (entry.node.isConnected && entry.node.getAttribute(entry.attribute) === entry.last) entry.node.setAttribute(entry.attribute, entry.last = t(entry.source));
  }
  const listeners = [];
  function setLanguage(next) {
    if (!supported.includes(next) || next === language) return;
    language = next;
    try { localStorage.setItem(languageKey, next); } catch {}
    applyStatic();
    for (const listener of listeners) listener();
  }
  TL.I18n = { t, english, catalog, preferredLanguage, initializeStatic, setLanguage,
    get language() { return language; }, onChange: listener => listeners.push(listener) };
  catalog(TL.PATTERNS);
})(globalThis.TL);
