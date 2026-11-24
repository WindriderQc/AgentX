'use strict';

const courtesy = '(?:s il (?:te|vous) plait|stp|svp|please)';
const politeStart = new RegExp('^' + courtesy + '[, ]+');
const politeEnd = new RegExp('[, ]+' + courtesy + '$');

// Normalize the request around the question. Keep its place, time and negation
// intact so the current-conditions and forecast contracts can choose separately.
function weatherQuestionWords(text) {
  if (typeof text !== 'string') return '';
  const words = text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[’'-]/g, ' ').trim().replace(/[.!?,]+$/, '').trim().replace(/\s+/g, ' ');
  return words.replace(/^nestor[, ]+/, '')
    .replace(politeStart, '')
    .replace(politeEnd, '')
    .replace(/^(?:(?:peux tu|pourrais tu|(?:est ce que )?tu (?:peux|pourrais)) (?:me )?(?:dire|redire|donner|redonner|rappeler|repeter)|(?:dis|redis|donne|redonne|rappelle|repete) moi|(?:could|can) you tell me) /, '');
}

module.exports = { weatherQuestionWords };
