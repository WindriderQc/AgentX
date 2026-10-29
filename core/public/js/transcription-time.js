'use strict';
(function (root) {
  function wallParts(instant, timeZone) {
    return Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit',
      day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(instant)).map(p => [p.type, p.value]));
  }
  function wallKey(instant, timeZone) {
    const p = wallParts(instant, timeZone);
    return p.year + '-' + p.month + '-' + p.day + 'T' + p.hour + ':' + p.minute;
  }
  function resolve(local, timeZone) {
    if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d$/.test(local)) throw Error('Choisissez une date et une heure complètes.');
    const naive = Date.parse(local + ':00Z');
    if (!Number.isFinite(naive)) throw Error('Date invalide.');
    // All offsets present around the chosen day, including both sides of DST.
    const offsets = new Set();
    for (let delta = -36; delta <= 36; delta += 6) {
      const instant = naive + delta * 3600000, p = wallParts(instant, timeZone);
      offsets.add(Date.parse(p.year + '-' + p.month + '-' + p.day + 'T' + p.hour + ':' + p.minute + ':00Z') - instant);
    }
    const matches = [...offsets].map(offset => naive - offset).filter(at => wallKey(at, timeZone) === local);
    if (!matches.length) throw Error('Cette heure n’existe pas dans ce fuseau (changement d’heure).');
    if (matches.length > 1) throw Error('Cette heure existe deux fois dans ce fuseau. Choisissez une heure sans ambiguïté.');
    return new Date(matches[0]).toISOString();
  }
  const api = { resolve, wallKey };
  if (typeof module !== 'undefined') module.exports = api;
  else root.TranscriptionTime = api;
})(typeof window === 'undefined' ? globalThis : window);
