(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ImageBriefConstraints = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';
  var MAX_ITEMS = 20, MAX_TEXT = 300, MAX_TOTAL = 4000, MAX_PROMPT = 8000;
  var KINDS = { 'exact-text': 'Texte exact à afficher', 'required-element': 'Élément obligatoire', composition: 'Composition ou relation' };
  function fail(message) { throw Object.assign(new Error(message), { statusCode: 400 }); }
  function object(value, keys) {
    if (!value || Object.prototype.toString.call(value) !== '[object Object]' ||
        Object.keys(value).some(function (key) { return keys.indexOf(key) === -1; }) ||
        keys.some(function (key) { return !Object.prototype.hasOwnProperty.call(value, key); })) {
      fail('Contraintes du brief invalides.');
    }
  }
  function validate(value) {
    if (value === undefined) return undefined;
    object(value, ['version', 'items']);
    if (value.version !== 1 || !Array.isArray(value.items) || value.items.length > MAX_ITEMS) fail('Vingt contraintes au maximum.');
    var ids = new Set(), total = 0;
    var items = value.items.map(function (item) {
      object(item, ['id', 'kind', 'text']);
      if (typeof item.id !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(item.id) || ids.has(item.id) ||
          typeof item.kind !== 'string' || !Object.prototype.hasOwnProperty.call(KINDS, item.kind)) fail('Identité ou catégorie de contrainte invalide.');
      ids.add(item.id);
      if (typeof item.text !== 'string' || !item.text.trim() || item.text.length > MAX_TEXT * 2 || Array.from(item.text).length > MAX_TEXT) {
        fail('Chaque contrainte exige un texte de 300 caractères au maximum.');
      }
      for (var character of item.text) {
        var point = character.codePointAt(0);
        if ((point < 32 && point !== 9 && point !== 10 && point !== 13) || (point >= 0xD800 && point <= 0xDFFF) || point === 0xFFFE || point === 0xFFFF) {
          fail('Une contrainte contient un caractère invalide.');
        }
      }
      total += Array.from(item.text).length;
      if (total > MAX_TOTAL) fail('Les contraintes dépassent 4 000 caractères.');
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
    if (typeof prompt !== 'string') fail('Le brief doit être un texte.');
    var suffix = block(value);
    var text = prompt.trim();
    // Remove only our exact canonical suffix, never infer intentions from prose.
    if (suffix && text.endsWith('\n\n' + suffix)) text = text.slice(0, -suffix.length - 2).trim();
    return text;
  }
  function compose(prompt, value) {
    var text = visual(prompt, value), suffix = block(value);
    var composed = text + (suffix ? '\n\n' + suffix : '');
    if (composed.length > MAX_PROMPT) fail('Brief et contraintes dépassent 8 000 caractères. Réduis le texte avant de continuer.');
    return composed;
  }
  return { MAX_ITEMS: MAX_ITEMS, MAX_TEXT: MAX_TEXT, MAX_TOTAL: MAX_TOTAL, MAX_PROMPT: MAX_PROMPT,
    KINDS: Object.freeze(KINDS), validate: validate, block: block, visual: visual, compose: compose };
});
