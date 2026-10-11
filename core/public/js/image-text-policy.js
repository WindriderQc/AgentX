(function (root, factory) {
  var constraints = typeof module === 'object' && module.exports ? require('./image-brief-constraints') : root.ImageBriefConstraints;
  var api = factory(constraints);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ImageTextPolicy = api;
})(typeof window !== 'undefined' ? window : globalThis, function (constraints) {
  'use strict';
  var MAX_LABELS = 20, MAX_TOTAL = 4000;
  var STRATEGIES = { auto: 'Hermes conseille', 'single-pass': 'Une passe · texte généré', 'two-pass': 'Deux passes · calques exacts' };
  function fail(message) { throw Object.assign(new Error(message), { statusCode: 400 }); }
  function record(value, keys) {
    if (!value || Object.prototype.toString.call(value) !== '[object Object]' || Object.keys(value).some(function (key) { return keys.indexOf(key) < 0; }) || keys.some(function (key) { return !Object.prototype.hasOwnProperty.call(value, key); })) fail('Préparation des textes invalide.');
  }
  function text(value, maximum, empty) {
    if (typeof value !== 'string' || (!empty && !value.trim()) || Array.from(value).length > maximum) fail('Texte ou placement trop long ou vide.');
    for (var character of value) {
      var point = character.codePointAt(0);
      if ((point < 32 && point !== 9 && point !== 10 && point !== 13) || (point >= 0xD800 && point <= 0xDFFF) || point === 0xFFFE || point === 0xFFFF) fail('Un libellé contient un caractère invalide.');
    }
    return value;
  }
  function labels(value) {
    if (!Array.isArray(value) || value.length > MAX_LABELS) fail('Vingt libellés au maximum.');
    var ids = new Set(), total = 0;
    return value.map(function (item) {
      record(item, ['id', 'text', 'placement']);
      if (typeof item.id !== 'string' || !/^[A-Za-z0-9_.:-]{1,160}$/.test(item.id) || ids.has(item.id)) fail('Identité de libellé invalide.');
      ids.add(item.id);
      var clean = { id: item.id, text: text(item.text, 300, false), placement: text(item.placement, 240, true) };
      total += Array.from(clean.text).length + Array.from(clean.placement).length;
      if (total > MAX_TOTAL) fail('Les textes et placements dépassent 4 000 caractères.');
      return clean;
    });
  }
  function validate(value) {
    if (value === undefined) return undefined;
    record(value, ['version', 'enabled', 'strategy', 'labels']);
    if (value.version !== 1 || typeof value.enabled !== 'boolean' || typeof value.strategy !== 'string' || !Object.prototype.hasOwnProperty.call(STRATEGIES, value.strategy)) fail('Choix de texte invalide.');
    return { version: 1, enabled: value.enabled, strategy: value.strategy, labels: labels(value.labels) };
  }
  function known(value, protectedItems) {
    var policy = validate(value), items = constraints.validate(protectedItems);
    if (!policy) return [];
    var exact = (items?.items || []).filter(function (item) { return item.kind === 'exact-text'; });
    if (!policy.enabled && exact.length) fail('Le brief contient des contraintes de texte exact. Coche « Textes dans l’image » ou retire ces contraintes.');
    if (!policy.enabled) return [];
    var result = policy.labels.slice();
    exact.forEach(function (item) {
      if (!result.some(function (label) { return label.text === item.text; })) result.push({ id: 'constraint.' + item.id, text: item.text, placement: '' });
    });
    return labels(result);
  }
  function validatePlan(value, requested, protectedItems) {
    var policy = validate(requested);
    if (!policy?.enabled) {
      if (value !== undefined) fail('Hermes a proposé des textes alors que leur génération est désactivée.');
      return undefined;
    }
    record(value, ['version', 'strategy', 'reason', 'labels']);
    if (value.version !== 1 || !['single-pass', 'two-pass'].includes(value.strategy) || (policy.strategy !== 'auto' && value.strategy !== policy.strategy)) fail('Hermes a changé la méthode de texte choisie.');
    var result = { version: 1, strategy: value.strategy, reason: text(value.reason, 1000, false), labels: labels(value.labels) };
    if (!result.labels.length) fail('Hermes doit proposer les textes à afficher avant de préparer l’image.');
    known(policy, protectedItems).forEach(function (item) {
      var proposed = result.labels.find(function (label) { return label.id === item.id; });
      if (!proposed || proposed.text !== item.text || (item.placement && proposed.placement !== item.placement)) fail('Hermes a modifié ou omis un texte exact ou son placement demandé.');
    });
    return result;
  }
  function applyPlan(value, requested, protectedItems) {
    var policy = validate(requested), plan = validatePlan(value, policy, protectedItems);
    return plan ? { version: 1, enabled: true, strategy: plan.strategy, labels: plan.labels } : policy;
  }
  function letteringBlock(policy, items) {
    var lines;
    if (!policy.enabled) lines = ['Aucun texte dans l’image : aucune lettre, aucun chiffre, aucune étiquette, aucun logo contenant du texte. Utiliser des objets et pictogrammes pour expliquer la scène.', 'Les marges restent sans légendes ni traits d’annotation. Les papiers, panneaux et écrans sont unis ou portent des pictogrammes sans écriture.'];
    else {
      if (policy.strategy === 'single-pass') lines = ['Écrire uniquement les textes exacts suivants, sans les reformuler. Leur orthographe et leur placement devront être vérifiés après génération.'].concat(items.map(function (item) { return '- ' + JSON.stringify(item.text) + (item.placement ? ' · ' + item.placement : ''); }));
      else lines = ['Première passe : illustration sans aucun texte, lettre ou chiffre. Les libellés seront ajoutés ensuite en calques typographiques.', 'Réserver des surfaces vides, sobres, contrastées et assez larges pour les libellés. Préférer des cartouches horizontaux vus de face, près des zones concernées, sans masquer les objets.', 'Les marges restent sans légendes ni traits d’annotation. Les panneaux, papiers et écrans restent vierges ou pictographiques.'].concat(items.map(function (item, index) { return '- Surface vierge ' + (index + 1) + ' : ' + (item.placement || 'près de la zone correspondante décrite dans le brief') + '.'; }));
    }
    return 'GESTION DES TEXTES DANS L’IMAGE\n' + lines.join('\n') + '\nFIN DE LA GESTION DES TEXTES';
  }
  function block(value, protectedItems) {
    var policy = validate(value);
    if (!policy) return '';
    var items = known(policy, protectedItems);
    if (policy.enabled && policy.strategy === 'auto') fail('Demande conseil à Hermes ou choisis une ou deux passes avant de créer.');
    if (policy.enabled && !items.length) fail('Indique les textes exacts, ou demande à Hermes de les proposer.');
    return letteringBlock(policy, items);
  }
  function suffix(protectedItems, policy, labels) {
    var active = policy?.enabled && policy.strategy === 'two-pass' && protectedItems ? { version: 1, items: protectedItems.items.filter(function (item) { return item.kind !== 'exact-text'; }) } : protectedItems;
    return [constraints.block(active), policy ? letteringBlock(policy, labels) : ''].filter(Boolean).join('\n\n');
  }
  function planningBudget(protectedItems, value) {
    var policy = validate(value), items = constraints.validate(protectedItems), labels = known(policy, items);
    var modes = !policy || !policy.enabled ? ['no-text'] : policy.strategy === 'auto' ? ['single-pass', 'two-pass'] : [policy.strategy];
    var limits = {};
    modes.forEach(function (mode) {
      var tail = suffix(items, policy ? { ...policy, strategy: mode } : undefined, labels);
      limits[mode] = Math.max(0, constraints.MAX_PROMPT - (tail ? tail.length + 2 : 0));
    });
    return { version: 1, limit: constraints.MAX_PROMPT, descriptionLimits: limits, labelsMayChange: !!policy?.enabled };
  }
  function visual(prompt, protectedItems, value) {
    var policy = validate(value), items = constraints.validate(protectedItems), labels = known(policy, items);
    var text = constraints.visual(prompt, items);
    if (!policy || (policy.enabled && (policy.strategy === 'auto' || !labels.length))) return text;
    var tail = suffix(items, policy, labels), original = prompt.trim();
    return tail && original.endsWith('\n\n' + tail) ? original.slice(0, -tail.length - 2).trim() : text;
  }
  function inspect(prompt, protectedItems, value) {
    var policy = validate(value), items = constraints.validate(protectedItems), description = visual(prompt, items, policy), labels = known(policy, items);
    var needsPlan = !!policy?.enabled && (policy.strategy === 'auto' || !labels.length);
    if (needsPlan) return { needsPlan: true, prompt: null, renderUnits: null, visualUnits: description.length, overheadUnits: null, maxVisualUnits: null, remainingUnits: null };
    var tail = suffix(items, policy, labels), overhead = tail ? tail.length + 2 : 0;
    var composed = description + (tail ? '\n\n' + tail : '');
    return { needsPlan: false, prompt: composed, renderUnits: composed.length, visualUnits: description.length, overheadUnits: overhead,
      maxVisualUnits: Math.max(0, constraints.MAX_PROMPT - overhead), remainingUnits: constraints.MAX_PROMPT - composed.length };
  }
  function compose(prompt, protectedItems, value) {
    if (value === undefined) return constraints.compose(prompt, protectedItems);
    var result = inspect(prompt, protectedItems, value);
    if (result.needsPlan) block(value, protectedItems);
    if (result.renderUnits > constraints.MAX_PROMPT) fail('Rendu final : ' + result.renderUnits + ' / 8 000 caractères, dont ' + result.overheadUnits + ' de consignes. Réduis la description à ' + result.maxVisualUnits + ' caractères maximum ou affine le brief avec Hermes.');
    return result.prompt;
  }
  return { MAX_LABELS: MAX_LABELS, STRATEGIES: Object.freeze(STRATEGIES), validate: validate, known: known, validatePlan: validatePlan, applyPlan: applyPlan, block: block, visual: visual, inspect: inspect, planningBudget: planningBudget, compose: compose };
});
