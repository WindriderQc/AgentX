'use strict';

const { observationDetails } = require('./family-weather');
const { projectTomorrowHours } = require('./family-forecast');

// The Data producer has already collected this bulletin. The user's words
// never select its sections or authorize a new external lookup here.
async function forTurn(ambient, { timeZone, requestAt = new Date() } = {}) {
  let sections;
  try { sections = await ambient?.preparedWeather?.(); } catch { /* an optional reference may be offline */ }
  if (!sections) return { text: '', relay: '' };
  const { current, forecast } = sections;
  const details = current && observationDetails(current, timeZone);
  const observation = current?.status === 'available' && details.observationStatus === 'recent'
    && Date.parse(current.data?.observedAt) <= requestAt.getTime()
    ? { ...current.data, observedAtLocal: details.observedAtLocal } : null;
  const bulletin = forecast?.status === 'available' ? forecast.data : null;
  const periods = bulletin?.periods?.slice(0, 3).map(({ period, short, temperatures, precipitationChancePct }) =>
    ({ period, short, temperatures, precipitationChancePct }));
  const outlook = periods?.length ? { forecastIssuedAt: bulletin.forecastIssuedAt, issueDate: bulletin.issueDate,
    timeZone: bulletin.timeZone, fetchedAt: bulletin.fetchedAt, periods } : null;
  const text = observation || outlook
    ? '\nPrepared local weather from Environnement Canada (reference data, use only when relevant): ' +
      JSON.stringify({ observation, forecastExcerpt: outlook }) +
      '. Period labels refer to the local issue date. Read the forecast or alerts section for additional coverage.'
    : '';

  // The local backup has a smaller instruction budget. Send dated numbers
  // only. Provider descriptions belong in the principal's reference data.
  const relayCurrent = observation && Number.isFinite(observation.temperatureC)
    ? 'Local station: ' + JSON.stringify({ observedAt: observation.observedAt, temperatureC: observation.temperatureC, windKmh: observation.windKmh }) : '';
  const tomorrow = bulletin && projectTomorrowHours(bulletin, { timeZone, requestAt });
  const hours = tomorrow?.hourly.filter(row => Number.isFinite(row.temperatureC) || Number.isFinite(row.precipitationChancePct))
    .map(row => [row.localTime, row.offset, row.temperatureC ?? null, row.precipitationChancePct ?? null]);
  const relayForecast = hours?.length ? 'Environnement Canada hourly forecast: ' + JSON.stringify({
    date: tomorrow.targetDate, timeZone: tomorrow.timeZone, issuedAt: tomorrow.forecastIssuedAt,
    columns: ['local time', 'UTC offset', '°C', 'precipitation %'], coveredHours: hours
  }) : '';
  const relay = [relayCurrent, relayForecast].filter(Boolean).join('\n');
  return { text, relay: relay.length <= 1600 ? relay : relayCurrent };
}

module.exports = { forTurn };
