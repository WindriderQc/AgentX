(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ImageBriefConstraints = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';
  var MAX_ITEMS = 20, MAX_TEXT = 300, MAX_TOTAL = 4000, MAX_PROMPT = 8000, MAX_BRIEF = 32000;
  // KINDS words are part of the prompt block sent to the image model; LABELS name the same kinds on screen.
  var KINDS = { 'exact-text': 'Texte exact à afficher', 'required-element': 'Élément obligatoire', composition: 'Composition ou relation' };
  var LABELS = { 'exact-text': 'Exact text to display', 'required-element': 'Required element', composition: 'Composition or relation' };
  function fail(message) { throw Object.assign(new Error(message), { statusCode: 400 }); }
  function object(value, keys) {
    if (!value || Object.prototype.toString.call(value) !== '[object Object]' ||
        Object.keys(value).some(function (key) { return keys.indexOf(key) === -1; }) ||
        keys.some(function (key) { return !Object.prototype.hasOwnProperty.call(value, key); })) {
      fail('Invalid brief constraints.');
    }
  }
  function validate(value) {
    if (value === undefined) return undefined;
    object(value, ['version', 'items']);
    if (value.version !== 1 || !Array.isArray(value.items) || value.items.length > MAX_ITEMS) fail('Twenty constraints at most.');
    var ids = new Set(), total = 0;
    var items = value.items.map(function (item) {
      object(item, ['id', 'kind', 'text']);
      if (typeof item.id !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(item.id) || ids.has(item.id) ||
          typeof item.kind !== 'string' || !Object.prototype.hasOwnProperty.call(KINDS, item.kind)) fail('Invalid constraint identity or category.');
      ids.add(item.id);
      if (typeof item.text !== 'string' || !item.text.trim() || item.text.length > MAX_TEXT * 2 || Array.from(item.text).length > MAX_TEXT) {
        fail('Each constraint requires a text of at most 300 characters.');
      }
      for (var character of item.text) {
        var point = character.codePointAt(0);
        if ((point < 32 && point !== 9 && point !== 10 && point !== 13) || (point >= 0xD800 && point <= 0xDFFF) || point === 0xFFFE || point === 0xFFFF) {
          fail('A constraint contains an invalid character.');
        }
      }
      total += Array.from(item.text).length;
      if (total > MAX_TOTAL) fail('The constraints exceed 4,000 characters.');
      return { id: item.id, kind: item.kind, text: item.text };
    });
    return items.length ? { version: 1, items: items } : undefined;
  }
  function block(value) {
    var constraints = validate(value);
    if (!constraints) return '';
    return 'CONTRAINTES EXPLICITES À CONSERVER\n' + constraints.items.map(function (item) {
      return '- ' + KINDS[item.kind] + ' : «' + item.text + '»';
    }).join('\n') + '\nFIN DES CONTRAINTES EXPLICITES';
  }
  function visual(prompt, value) {
    if (typeof prompt !== 'string') fail('The brief must be text.');
    var suffix = block(value);
    var text = prompt.trim();
    // Remove only our exact canonical suffix, never infer intentions from prose.
    if (suffix && text.endsWith('\n\n' + suffix)) text = text.slice(0, -suffix.length - 2).trim();
    return text;
  }
  function composeWithin(prompt, value, limit, message) {
    var text = visual(prompt, value), suffix = block(value);
    var composed = text + (suffix ? '\n\n' + suffix : '');
    if (composed.length > limit) fail(message);
    return composed;
  }
  function compose(prompt, value) {
    return composeWithin(prompt, value, MAX_PROMPT, 'Brief and constraints exceed 8,000 characters. Shorten the text before continuing.');
  }
  function composeBrief(prompt, value) {
    return composeWithin(prompt, value, MAX_BRIEF, 'Brief and constraints exceed 32,000 UTF-16 characters. Shorten the text before continuing.');
  }
  return { MAX_ITEMS: MAX_ITEMS, MAX_TEXT: MAX_TEXT, MAX_TOTAL: MAX_TOTAL, MAX_PROMPT: MAX_PROMPT, MAX_BRIEF: MAX_BRIEF,
    KINDS: Object.freeze(KINDS), LABELS: Object.freeze(LABELS), validate: validate, block: block, visual: visual, compose: compose, composeBrief: composeBrief };
});
