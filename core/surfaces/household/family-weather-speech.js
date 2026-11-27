'use strict';

const { weatherKind } = require('./family-ambient');
const { numberAt } = require('./math-scene');
const { speechText } = require('../../public/js/voice/speech-language');

const englishConditions = { clear: 'Clear skies', cloud: 'Cloudy skies', rain: 'Rain', snow: 'Snow', storm: 'Stormy conditions', fog: 'Low visibility' };

function spokenMeasurement(value, language) {
  const number = Math.abs(value).toLocaleString(language === 'en' ? 'en-CA' : 'fr-CA',
    { useGrouping: false, maximumSignificantDigits: 17 });
  return value < 0 ? (language === 'en' ? 'minus ' : 'moins ') + number : number;
}

function observationSpeech(weather, language) {
  const en = language === 'en';
  const temperature = spokenMeasurement(weather.temperatureC, language);
  const singular = new Intl.PluralRules(language).select(Math.abs(weather.temperatureC)) === 'one';
  const degrees = en ? (singular ? 'degree Celsius' : 'degrees Celsius') : (singular ? 'degré Celsius' : 'degrés Celsius');
  const condition = speechText(weather.condition).trim().replace(/[.!?]+$/, '');
  const sky = en ? englishConditions[weatherKind({ condition })] || (condition && 'The station reports “' + condition + '”') : condition;
  const sentences = [(en ? 'It is ' : 'Il fait ') + temperature + ' ' + degrees, sky].filter(Boolean);
  if (Number.isFinite(weather.windKmh)) {
    const wind = spokenMeasurement(weather.windKmh, language);
    const unit = new Intl.PluralRules(language).select(Math.abs(weather.windKmh)) === 'one'
      ? (en ? 'kilometre' : 'kilomètre') : (en ? 'kilometres' : 'kilomètres');
    sentences.push(en ? 'The wind speed is ' + wind + ' ' + unit + ' per hour' : 'Le vent souffle à ' + wind + ' ' + unit + ' à l’heure');
  }
  return sentences.join('. ') + '.';
}

// Keep a spoken measurement only when its signed value and adjacent unit agree
// with the observation. Unrelated numbers and uncertain wording use the source.
function speaksMeasurement(text, weather) {
  const words = speechText(text).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/([−-])(?=\s*\d)/g, ' minus ').replace(/(\d),(?=\d)/g, '$1.')
    .match(/\d+(?:\.\d+)?|[a-z]+|°/g) || [];
  const wind = Number.isFinite(weather.windKmh);
  const value = wind ? weather.windKmh : weather.temperatureC;
  for (let i = 0; i < words.length; i++) {
    const token = words[i], sign = ['minus', 'moins', 'negative'].includes(words[i - 1]) ? -1 : 1;
    const number = /^\d/.test(token) ? { value: Number(token), next: i + 1 } : numberAt(words, i);
    if (!number) continue;
    const preceding = words[i - 1];
    i = number.next - 1;
    if (sign * number.value !== value || ['point', 'virgule'].includes(preceding)) continue;
    const [unit, qualifier] = words.slice(number.next, number.next + 2);
    const unitMatches = wind
      ? unit === 'km' && qualifier === 'h' || /^kilomet(?:er|re)s?$/.test(unit) && ['par', 'a', 'per', 'an'].includes(qualifier)
      : ['°', 'degre', 'degres', 'degree', 'degrees', 'celsius'].includes(unit) && !['f', 'fahrenheit'].includes(qualifier);
    if (unitMatches) return true;
  }
  return false;
}

function projectionFor(weather, language) {
  if (!weather) return null;
  return text => speaksMeasurement(text, weather) ? text : observationSpeech(weather, language);
}

module.exports = { projectionFor };
