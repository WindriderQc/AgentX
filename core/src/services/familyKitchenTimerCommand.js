// Narrow by design: other requests remain ordinary conversation.
'use strict';
const MAX_SECONDS = 24 * 3600;
const numbers = Object.assign(Object.create(null), {
  un: 1, une: 1, deux: 2, trois: 3, quatre: 4, cinq: 5, six: 6, sept: 7,
  huit: 8, neuf: 9, dix: 10, onze: 11, douze: 12, treize: 13, quatorze: 14,
  quinze: 15, seize: 16, vingt: 20, trente: 30, quarante: 40, cinquante: 50, soixante: 60,
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  fifteen: 15, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60
});
const quantity = '([0-9]{1,6}|' + Object.keys(numbers).join('|') + ')';
const unit = '(heures?|h|minutes?|min|secondes?|sec|hours?|seconds?|s)';
const part = new RegExp('^' + quantity + '\\s*' + unit + '(?=\\s|$)');
const timer = '(?:(?:une|la|un|le|a|the|my) )?(?:minuterie|chrono(?:metre)?|timer)';
const startVerb = '^(?:mets(?: moi)?|pars|demarre|lance|regle|programme|set|start) ' + timer;
const start = new RegExp(startVerb + '(?: de| pour| for)? (.+)$');
const noDuration = new RegExp(startVerb + '$');
const cancel = new RegExp('^(?:annule|arrete|stoppe|cancel|stop) ' + timer + '$');
const explicitStatus = /^(?:combien (?:de temps )?(?:(?:il )?reste|reste t il|y reste)(?: (?:sur|a) (?:la |le )?(?:minuterie|chrono|timer))?|(?:quel est le |dis moi le )?temps restant (?:sur|a) (?:la |le )?(?:minuterie|chrono|timer)|how much time (?:is )?left on (?:the )?timer)$/;
function normalize(text) {
  return String(text || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ').trim().replace(/^(?:dis |ok |hey )?nestor +/, '').replace(/ s il (?:te|vous) plait$/, '');
}
function duration(text) {
  let rest = text.trim(), seconds = 0, lastScale = Infinity;
  while (rest) {
    const match = rest.match(part);
    if (!match) return null;
    const count = /^\d+$/.test(match[1]) ? Number(match[1]) : numbers[match[1]];
    const scale = /^h/.test(match[2]) ? 3600 : /^m/.test(match[2]) ? 60 : 1;
    if (!count || scale >= lastScale || (lastScale !== Infinity && count >= 60)) return null;
    seconds += count * scale;
    lastScale = scale;
    rest = rest.slice(match[0].length).trim().replace(/^(?:et|and) +(?=\S)/, '');
  }
  return seconds > 0 && seconds <= MAX_SECONDS ? seconds : null;
}
function parse(text) {
  const value = normalize(text);
  const started = value.match(start);
  if (noDuration.test(value)) return { action: 'invalid' };
  if (started) {
    if (/(?:^|\s)[-\u2212]\d|\d[.,]\d/.test(String(text))) return { action: 'invalid' };
    const seconds = duration(started[1]);
    if (seconds) return { action: 'start', seconds };
    // Do not capture a compound user request merely because it begins with a timer.
    if (/^[0-9]/.test(started[1]) && /^[0-9a-z ]+$/.test(started[1])
      && /^(?:[0-9]+ (?:heures?|h|minutes?|min|secondes?|sec|hours?|seconds?|s)|[0-9]+)$/.test(started[1])) return { action: 'invalid' };
    return null;
  }
  if (cancel.test(value)) return { action: 'cancel' };
  if (explicitStatus.test(value)) return { action: 'status', explicit: /\b(?:minuterie|chrono|timer)\b/.test(value) };
  return null;
}
module.exports = { parse, MAX_SECONDS };
