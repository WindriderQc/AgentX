'use strict';

// The pieces added to the IoT tab after its first five iterations: signal
// gauge, model line, registry table, consumer status, the « Tout » period, the
// median line with its min–max band, two-step commands, the device's events
// and the "not back yet" note. Device names are synthetic.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { COMMANDS } = require('../../../../shared/iotDeviceRules');

const PUBLIC = path.join(__dirname, '../public');
const FILES = ['refresh.js', 'iot-visuals.js', 'iot-appearance.js', 'iot-charts.js', 'iot-combined.js', 'iot-fleet.js', 'iot-commands.js', 'iot-events.js', 'iot.js', 'activity.js', 'app.js'];
const EXPORTS = ['state', 'render', 'iotState', 'iotTab', 'iotSelect', 'iotLoadSeries', 'iotSubmit', 'iotRefresher', 'iotChart', 'iotCards', 'iotCombinedModel', 'iotCombinedHtml',
  'iotCombinedBounds', 'iotBandRuns', 'iotCurveStyle', 'iotStoreCurveStyle', 'iotReadReading', 'iotStoreReading', 'iotCentral', 'iotReadingHint', 'iotResolutionUsed',
  'iotSignalQuality', 'iotSignalGauge', 'iotModelLine', 'iotRegistryHtml', 'iotConsumerHtml', 'iotMissingHtml', 'iotAge',
  'IOT_COMMANDS', 'IOT_SIGNAL_LEGEND', 'iotCommand', 'iotCommandBlock', 'iotCommandArm', 'iotCommandSend', 'iotCommandHtml', 'iotCommandOutcome',
  'iotEvents', 'iotEventsHtml', 'iotLoadEvents', 'activityState'];
const HOSTILE = '<img src=x onerror=evil()>"\'';
const AT = new Date().toISOString();
const ago = ms => new Date(Date.now() - ms).toISOString();
const device = (id = 'SYN_1', extra = {}) => ({ id, status: 'online', displayName: null, location: null, notes: null,
  firstSeenAt: ago(40 * 3600000), lastSeenAt: AT, availability: { state: 'online', since: ago(3 * 3600000) }, staleSince: null,
  info: { name: id, manufacturer: 'Synthetic Works', model: 'Node A', swVersion: null, hwVersion: null }, measures: [
    { key: 'temperature', name: 'Temperature', unit: '°C', value: 23.5, at: AT },
    { key: 'wifi_rssi', name: 'Wi-Fi signal', unit: 'dBm', value: -75, at: AT },
    { key: 'battery_voltage', name: 'Battery voltage', unit: 'V', value: 4.22, at: AT }
  ], ...extra });
const status = (extra = {}) => ({ consumer: { running: true, configured: true, connected: true, broker: 'broker.test:1883', startedAt: ago(7200000) },
  devices: { tracked: 2, limit: 100, online: 1, offline: 1, stale: 0, unknown: 0 },
  readings: { accepted: 1234, refused: 5, refusedByReason: { not_numeric: 3, [HOSTILE]: 2 }, lastAt: AT },
  buckets: { written: 77, open: 3, pendingRetry: 0, dropped: 0, lastWriteAt: ago(60000), lastError: null },
  rollup: { through: ago(3600000), lastRunAt: ago(300000) }, settings: { minuteRetentionDays: 90, staleAfterSeconds: 300, liveRingSize: 60 }, ...extra });
const bucket = (ts, median, mean, min, max, count = 12) => ({ ts: new Date(ts).toISOString(), median, mean, min, max, count });

function browser(respond, localStorage) {
  const elements = {}; const listeners = {}; const requests = []; const timeouts = [];
  const element = selector => elements[selector] ||= { innerHTML: '', textContent: '', value: '', disabled: false,
    setAttribute() {}, querySelectorAll() { return []; }, contains() { return false; } };
  const document = { hidden: false, querySelector: element, querySelectorAll() { return []; }, addEventListener(name, handler) { (listeners[name] ||= []).push(handler); } };
  const context = { document, location: { hash: '#iot' }, window: { addEventListener() {} }, localStorage, console, URLSearchParams, Date,
    FormData: class { constructor(form) { return Object.entries(form.fields); } },
    setInterval() { return 1; }, clearInterval() {},
    setTimeout(callback, ms) { timeouts.push({ callback, ms, cleared: false }); return timeouts.length; },
    clearTimeout(id) { if (timeouts[id - 1]) timeouts[id - 1].cleared = true; },
    async fetch(url, options = {}) {
      const parsed = new URL(url, 'http://localhost');
      const call = { path: parsed.pathname.replace('/api/data-toolbox', ''), query: parsed.searchParams, method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : undefined };
      requests.push(call); const answer = await respond(call);
      if (answer?.throwTransport) throw new Error('network down');
      return answer instanceof Error ? { ok: false, status: answer.status || 502, json: async () => ({ status: 'error', message: answer.message }) }
        : { ok: true, status: 200, json: async () => ({ status: 'success', data: answer }) };
    }
  };
  const source = FILES.map(file => fs.readFileSync(path.join(PUBLIC, file), 'utf8')).join('\n')
    .replace(/\nrender\(\);\s*$/, `\nglobalThis.page = { ${EXPORTS.join(', ')} };`);
  vm.runInNewContext(source, context);
  const click = selector => listeners.click.forEach(handler => handler({ target: { closest: wanted => wanted === selector ? { dataset: {} } : null } }));
  return { ...context.page, elements, listeners, requests, timeouts, document, click, content: element('#content') };
}

function fakeData(store = {}) {
  store.devices ||= [device()];
  return async call => {
    if (call.path === '/iot/status') return store.status === null ? new Error('status down') : store.status || status();
    if (call.path === '/iot/devices') return { devices: store.devices };
    if (call.path === '/events') return store.events instanceof Error ? store.events : { events: store.events || [], pagination: { total: store.eventTotal ?? (store.events || []).length } };
    if (call.path.endsWith('/live')) return { device: 'SYN_1', measures: { temperature: { unit: '°C', points: [{ ts: AT, value: 23.5 }] } } };
    if (call.path.endsWith('/history')) {
      const all = Date.parse(call.query.get('to')) - Date.parse(call.query.get('from')) > 800 * 3600000;
      return { device: 'SYN_1', bucket: all ? 'day' : 'minute', bucketSeconds: all ? 86400 : 60, source: all ? 'hour' : 'minute', from: call.query.get('from'), to: call.query.get('to'),
        measures: Object.fromEntries(call.query.get('measure').split(',').map(key => [key, { unit: 'V', points: store.points || [] }])) };
    }
    if (call.method === 'POST') return store.command ? store.command(call) : { device: 'SYN_1', command: call.body.command, topic: 'esp32/SYN_1/io/on', publishedAt: AT };
    throw new Error(`Unexpected ${call.method} ${call.path}`);
  };
}
const settle = async () => { for (let turn = 0; turn < 4; turn++) await new Promise(resolve => setImmediate(resolve)); };
const open = async (store = {}, storage) => { const page = browser(fakeData(store), storage); await page.render(); await settle(); return page; };
const posts = page => page.requests.filter(call => call.method !== 'GET');
const memory = (initial = {}) => { const saved = new Map(Object.entries(initial)); return { saved, getItem: key => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value) }; };

test('the page loads the added scripts before the tab and keeps the write list at nine', () => {
  const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
  for (const file of ['iot-fleet.js', 'iot-commands.js', 'iot-events.js']) {
    assert.ok(html.indexOf(`/assets/data-toolbox/${file}`) > 0 && html.indexOf(`/assets/data-toolbox/${file}`) < html.indexOf('/assets/data-toolbox/iot.js'), file);
  }
  assert.match(html, /iot-pieces\.css/);
  assert.match(html, /This page can send nine kinds of change to Data/);
  assert.equal((html.match(/data-write="/g) || []).length, 9);
  assert.doesNotMatch(html, /https?:\/\/(?!www\.w3\.org)/, 'no external address, no CDN');
  for (const file of fs.readdirSync(PUBLIC).filter(name => /^iot.*\.js$/.test(name))) {
    assert.doesNotMatch(fs.readFileSync(path.join(PUBLIC, file), 'utf8'), /\b(alert|confirm|prompt)\s*\(/, `${file} opens no native dialog`);
  }
});

test('the Wi-Fi gauge names the quality at each threshold and carries its reading as text', async () => {
  const page = await open();
  const word = dbm => page.iotSignalQuality(dbm).word;
  assert.deepEqual([-30, -55, -55.5, -70, -70.5, -80, -80.5, -130].map(word), ['Excellent', 'Excellent', 'Bon', 'Bon', 'Moyen', 'Moyen', 'Faible', 'Faible']);
  for (const unknown of [null, undefined, NaN, Infinity, '-60']) assert.equal(word(unknown), 'Inconnu');
  const gauge = page.iotSignalGauge(-75);
  assert.match(gauge, /<svg class="iot-gauge"[^>]*role="img" aria-label="Signal Wi-Fi -75 dBm : Moyen"/);
  assert.match(gauge, /<title>Signal Wi-Fi -75 dBm : Moyen\. Excellent : −55 dBm ou mieux · Bon : de −70 à −56 dBm · Moyen : de −80 à −71 dBm · Faible : sous −80 dBm<\/title>/);
  assert.equal((gauge.match(/<path d="M[^"]*A34 34/g) || []).length, 4, 'four bands');
  assert.equal((gauge.match(/opacity="1"/g) || []).length, 1, 'only the current band is lit');
  assert.doesNotMatch(page.iotSignalGauge(-250) + page.iotSignalGauge(40), /NaN|Infinity/);
  const empty = page.iotSignalGauge(null);
  assert.match(empty, /aria-label="Signal Wi-Fi inconnu"/);
  assert.doesNotMatch(empty, /stroke-linecap="round"/, 'no needle without a reading');
  const cards = page.elements['#iotCards'].innerHTML;
  assert.match(cards, /class="iot-measure iot-signal"[^>]*data-quality="moyen"[^>]*title="Excellent : −55 dBm ou mieux/);
  assert.match(cards, /<strong>-75<small> dBm<\/small><\/strong><em[^>]*>Moyen<\/em>/);
  assert.match(page.elements['#iotRegistry'].innerHTML, /Signal Wi-Fi — Excellent : −55 dBm ou mieux/, 'the thresholds are also written for touch screens');
});

test('a signal in another unit or without a value never gets an invented quality', async () => {
  const page = await open({ devices: [device('SYN_1', { measures: [{ key: 'wifi_rssi', name: 'Wi-Fi', unit: '%', value: 80, at: AT }] }),
    device('SYN_2', { measures: [{ key: 'wifi_rssi', name: 'Wi-Fi', unit: 'dBm', value: null, at: null }] })] });
  const cards = page.elements['#iotCards'].innerHTML;
  assert.equal((cards.match(/class="iot-gauge"/g) || []).length, 1, 'a percentage is not drawn on a dBm arc');
  assert.match(cards, /data-quality="inconnu"/);
  assert.match(cards, /<em[^>]*>Inconnu<\/em>/);
});

test('cards show maker, model and versions only when the registry holds them, escaped', async () => {
  const page = await open({ devices: [device('SYN_1', { info: { manufacturer: HOSTILE, model: 'Node A', swVersion: '1.4.2', hwVersion: 'rev C' } }),
    device('SYN_2', { info: { manufacturer: null, model: '  ', swVersion: 7 } }), device('SYN_3', { info: null })] });
  const cards = page.elements['#iotCards'].innerHTML;
  assert.match(cards, /class="iot-model"[^>]*>&lt;img src=x onerror=evil\(\)&gt;&quot;&#39; · Node A · micrologiciel 1\.4\.2 · matériel rev C<\/span>/);
  assert.equal((cards.match(/class="iot-model"/g) || []).length, 1, 'nothing is shown for a device without model information');
  assert.doesNotMatch(cards, /<img src=x/);
  assert.equal(page.iotModelLine({ info: { model: 'Node B' } }).includes('Node B'), true);
  assert.doesNotMatch(page.iotModelLine({ info: { model: 'Node B' } }), /micrologiciel|matériel|·/);
});

test('the registry table lists every device with first message, last activity, age and availability', async () => {
  const page = await open({ devices: [
    device('SYN_1', { displayName: HOSTILE, firstSeenAt: ago(72 * 3600000), lastSeenAt: ago(90000) }),
    device('SYN_2', { status: 'stale', staleSince: ago(600000), lastSeenAt: ago(900000) }),
    device('SYN_3', { status: 'unknown', availability: { state: 'unknown', since: null }, firstSeenAt: null, lastSeenAt: 'not a date' })] });
  page.iotState.filter = 'SYN_1';
  const table = page.iotRegistryHtml();
  assert.match(table, /<h3>Enregistré \/ dernière activité<\/h3>/);
  assert.match(table, /<th scope="col">Appareil<\/th><th scope="col">Identifiant<\/th><th scope="col">État<\/th><th scope="col">Enregistré<\/th><th scope="col">Dernière activité<\/th><th scope="col">Disponibilité<\/th>/);
  assert.equal((table.match(/<tr/g) || []).length, 4, 'the search filter of the cards does not hide registry rows');
  assert.match(table, /<tr class="selected"><th scope="row">&lt;img src=x onerror=evil\(\)&gt;/);
  assert.doesNotMatch(table, /<img src=x/);
  assert.match(table, /il y a 3 j/); assert.match(table, /il y a 1 min/);
  assert.match(table, /En ligne depuis /); assert.match(table, /Silencieux depuis /);
  assert.match(table, /<td><span class="muted">jamais<\/span><\/td><td><span class="muted">jamais<\/span><\/td><td><span class="muted">non annoncée<\/span><\/td>/);
  assert.match(table, /role="region" aria-label="Appareils enregistrés et dernière activité"/);
  assert.equal(page.iotAge(ago(47 * 3600000)), 'il y a 47 h');
  page.iotState.devices = []; assert.equal(page.iotRegistryHtml(), '');
});

test('the consumer card reports Data’s own counters, refusal reasons and retention without inventing any', async () => {
  const page = await open();
  const card = page.elements['#content'].innerHTML.match(/<section id="iotConsumer">.*?<\/section><section id="iotMissing">/s)[0];
  assert.match(card, /Lien broker<\/dt><dd><span class="iot-connection connected">.*Connecté/s);
  assert.match(card, /broker\.test:1883/);
  assert.match(card, /Appareils suivis<\/dt><dd>2 <span class="muted">\/ 100<\/span><\/dd><small>1 en ligne · 1 hors ligne<\/small>/);
  assert.match(card, /Mesures reçues<\/dt><dd>1[,.\s  ]?234<\/dd>/);
  assert.match(card, /Mesures refusées<\/dt><dd>5<\/dd><small>valeur non numérique : 3 · &lt;img src=x onerror=evil\(\)&gt;&quot;&#39; : 2<\/small>/);
  assert.match(card, /Dernière minute écrite/); assert.match(card, /77 tranches écrites/);
  assert.match(card, /Dernier regroupement horaire/); assert.match(card, /heures closes jusqu’à/);
  assert.match(card, /Rétention des minutes<\/dt><dd>90 jours<\/dd>/);
  assert.doesNotMatch(card, /<img src=x/);
  page.iotState.status = { consumer: { configured: false, connected: false }, buckets: { lastError: HOSTILE, pendingRetry: 4, dropped: 2 } };
  const bare = page.iotConsumerHtml();
  assert.match(bare, /Non configuré/); assert.match(bare, /Appareils suivis<\/dt><dd>—<\/dd>/); assert.match(bare, /Mesures reçues<\/dt><dd>—<\/dd>/);
  assert.match(bare, /4 en attente · 2 perdues · erreur : &lt;img/);
  page.iotState.status = null;
  assert.match(page.iotConsumerHtml(), /Data n’a pas répondu sur son état/);
  assert.equal(posts(page).length, 0);
});

test('« Tout » reads from the device’s first message with Data’s automatic resolution and shows the one used', async () => {
  const first = ago(200 * 24 * 3600000);
  const page = await open({ devices: [device('SYN_1', { firstSeenAt: first })] });
  assert.match(page.elements['#iotControls'].innerHTML, /data-iot-period="all" aria-pressed="false" aria-label="Tout l’historique">Tout<\/button>/);
  page.iotState.resolution = 'minute'; page.iotState.period = 'all';
  await page.iotLoadSeries();
  const call = page.requests.filter(item => item.path.endsWith('/history')).at(-1);
  assert.equal(call.query.get('resolution'), 'auto', 'a minute resolution chosen earlier is not sent for the whole history');
  assert.equal(call.query.get('from'), first);
  assert.ok(Date.now() - Date.parse(call.query.get('to')) < 5000);
  assert.equal(page.iotResolutionUsed(), 'Résolution utilisée : 1 jour (choisie par Data) · depuis les tranches horaires');
  assert.match(page.elements['#iotControls'].innerHTML, /data-iot-period="all"/);
  page.iotState.keys = ['temperature']; page.iotState.series.measures.temperature.points = [bucket(Date.now() - 86400000, 4, 4, 3, 5)];
  assert.match(page.iotCombinedHtml(), /<span id="iotResolutionUsed">Résolution utilisée : 1 jour \(choisie par Data\) · depuis les tranches horaires<\/span>/);
  page.iotState.view = 'individual'; await page.iotLoadSeries();
  assert.match(page.elements['#iotSeries'].innerHTML, /id="iotResolutionUsed">Résolution utilisée : 1 jour/);
  page.iotState.period = '24'; await page.iotLoadSeries();
  assert.equal(page.requests.filter(item => item.path.endsWith('/history')).at(-1).query.get('resolution'), 'minute');
  assert.equal(page.iotResolutionUsed(), 'Résolution utilisée : 1 min · depuis les tranches d’une minute');
  const unknownStart = await open({ devices: [device('SYN_1', { firstSeenAt: null })] });
  unknownStart.iotState.period = 'all'; await unknownStart.iotLoadSeries();
  const fallback = unknownStart.requests.filter(item => item.path.endsWith('/history')).at(-1);
  assert.equal(Date.parse(fallback.query.get('to')) - Date.parse(fallback.query.get('from')), 8760 * 3600000);
});

test('history lines follow the median by default, the mean on request, and fall back when one is absent', async () => {
  const page = await open(); const start = Date.parse('2026-01-01T00:00:00Z');
  page.iotState.period = '24'; page.iotState.keys = ['temperature'];
  page.iotState.series = { bucketSeconds: 60, measures: { temperature: { unit: '°C', points: [
    bucket(start, 20, 22, 18, 30), bucket(start + 60000, 21, 23, 19, 31), { ts: new Date(start + 120000).toISOString(), mean: 24, min: 24, max: 24, count: 1 },
    { ts: new Date(start + 180000).toISOString(), median: 25, count: 1 }] } } };
  assert.equal(page.iotState.central, 'median'); assert.equal(page.iotState.ranges, true);
  let metric = page.iotCombinedModel().metrics[0];
  assert.deepEqual(metric.points.map(point => point.value), [20, 21, 24, 25]);
  assert.equal(metric.banded, true); assert.equal(metric.min, 18); assert.equal(metric.max, 31, 'the band is inside the scale');
  assert.match(page.iotReadingHint(), /^La ligne suit la médiane de chaque tranche de temps ; la bande ombrée va du minimum au maximum mesurés/);
  assert.match(page.iotReadingHint(true), /axe affiché/); assert.doesNotMatch(page.iotReadingHint(false), /axe affiché/);
  const html = page.iotCombinedHtml();
  assert.match(html, /<option value="median" selected>Médiane<\/option><option value="mean">Moyenne<\/option>/);
  assert.match(html, /id="iotCombinedRanges" checked>Bande min–max/);
  assert.match(html, /<th scope="col">Médiane<\/th><th scope="col">Moyenne<\/th><th scope="col">Min<\/th><th scope="col">Max<\/th>/);
  page.iotState.central = 'mean';
  metric = page.iotCombinedModel().metrics[0];
  assert.deepEqual(metric.points.map(point => point.value), [22, 23, 24, 25]);
  assert.match(page.iotReadingHint(), /^La ligne suit la moyenne/);
  page.iotState.ranges = false;
  metric = page.iotCombinedModel().metrics[0];
  assert.equal(metric.banded, false); assert.equal(metric.min, 22); assert.equal(metric.max, 25);
  assert.doesNotMatch(page.iotReadingHint(), /bande/);
  page.iotState.ranges = true; page.iotState.period = 'live';
  page.iotState.series = { measures: { temperature: { points: [{ ts: AT, value: 5, min: 1, max: 9 }] } } };
  metric = page.iotCombinedModel().metrics[0];
  assert.equal(metric.banded, false, 'raw live readings have no band'); assert.equal(metric.min, 5);
  assert.doesNotMatch(page.iotCombinedHtml(), /iotCentral|iotCombinedRanges/);
});

test('the band is cut at gaps and does not stretch the axis of a jittering battery', async () => {
  const page = await open(); const start = Date.parse('2026-01-01T00:00:00Z');
  page.iotState.period = '24'; page.iotState.keys = ['battery_voltage'];
  const points = Array.from({ length: 30 }, (_, i) => bucket(start + i * 60000, i % 2 ? 4.22 : 4.24, 4.23, 4.2, 4.27));
  points.push(bucket(start + 3600000, 4.23, 4.23, 4.2, 4.27), { ts: new Date(start + 3660000).toISOString(), median: 4.23, count: 1 }, bucket(start + 3720000, 4.23, 4.23, 4.2, 4.27));
  page.iotState.series = { bucketSeconds: 60, measures: { battery_voltage: { unit: 'V', points } } };
  const banded = page.iotCombinedModel().metrics[0];
  const span = metric => (metric.high - metric.low) * metric.divisor;
  assert.ok(span(banded) >= .5 && span(banded) <= .8 + 1e-9, `battery axis spans ${span(banded)} V`);
  assert.ok(.07 / span(banded) < .15, 'a 0.07 V jitter band stays a thin strip');
  page.iotState.ranges = false;
  const line = page.iotCombinedModel().metrics[0];
  assert.ok(Math.abs(span(banded) - span(line)) < 1e-9, 'showing the band keeps the same axis height');
  page.iotState.ranges = true;
  const runs = page.iotBandRuns(banded);
  assert.deepEqual(Array.from(runs, run => run.length), [30, 1, 1], 'a gap and a bucket without extremes each end a band');
  const wide = page.iotCombinedBounds(4.07, 4.32, 'battery_voltage', 'V');
  assert.ok((wide.high - wide.low) * wide.divisor <= .8 + 1e-9);
});

test('individual charts draw the median with a shaded band, or the mean without it, and tabulate both', async () => {
  const page = await open();
  const points = [bucket('2026-01-01T00:00:00Z', 1, 1.5, 0, 3), bucket('2026-01-01T00:01:00Z', 2, 2.5, 1, 4), bucket('2026-01-01T00:02:00Z', 3, 3.5, 2, 5),
    bucket('2026-01-01T02:00:00Z', 9, 9.5, 8, 10)];
  const chart = page.iotChart(points, { name: 'Battery', unit: 'V', bucketSeconds: 60 });
  assert.equal((chart.match(/<polygon class="iot-band"/g) || []).length, 1);
  assert.equal((chart.match(/<line class="iot-range"/g) || []).length, 1, 'an isolated bucket keeps a vertical mark');
  assert.deepEqual([...chart.matchAll(/data-iot-point[^>]*data-value="([0-9.]+)"/g)].map(match => Number(match[1])), [1, 2, 3, 9]);
  assert.match(chart, /Ligne : médiane/);
  assert.match(chart, /<th scope="col">Médiane<\/th><th scope="col">Moyenne<\/th>/);
  assert.match(chart, /<td>1 V<\/td><td>1\.5<\/td><td>0<\/td><td>3<\/td>/);
  const mean = page.iotChart(points, { name: 'Battery', unit: 'V', bucketSeconds: 60, central: 'mean', band: false });
  assert.doesNotMatch(mean, /iot-band|class="iot-range"/);
  assert.deepEqual([...mean.matchAll(/data-iot-point[^>]*data-value="([0-9.]+)"/g)].map(match => Number(match[1])), [1.5, 2.5, 3.5, 9.5]);
  assert.match(mean, /Ligne : moyenne/);
  assert.doesNotMatch(chart + mean, /NaN|Infinity/);
});

test('the reading choice is remembered under its own key and leaves saved curve styles untouched', async () => {
  const styles = JSON.stringify({ version: 1, devices: [{ id: 'SYN_1', curves: [{ key: 'temperature', width: 3, line: 'dashed', curve: 'step', fill: 'solid', opacity: 30, points: true, glow: true, scale: 'detail' }] }] });
  const storage = memory({ 'agentx.iot.curve-styles.v1': styles });
  const page = await open({}, storage);
  assert.equal(page.iotState.central, 'median'); assert.equal(page.iotState.ranges, true, 'a browser with only the earlier preferences gets the new default');
  assert.equal(page.iotCurveStyle('temperature').width, 3); assert.equal(page.iotCurveStyle('temperature').scale, 'detail');
  assert.equal(storage.saved.size, 1, 'reading the defaults writes nothing');
  const change = target => page.listeners.change.forEach(handler => handler({ type: 'change', target: { dataset: {}, ...target } }));
  change({ id: 'iotCentral', value: 'mean' });
  change({ id: 'iotCombinedRanges', checked: false });
  assert.deepEqual(JSON.parse(storage.saved.get('agentx.iot.reading.v1')), { version: 1, central: 'mean', band: false });
  assert.equal(storage.saved.get('agentx.iot.curve-styles.v1'), styles);
  const again = await open({}, storage);
  assert.equal(again.iotState.central, 'mean'); assert.equal(again.iotState.ranges, false);
  assert.equal(again.iotCurveStyle('temperature').line, 'dashed');
  for (const raw of ['not json', '{"version":2,"central":"mean","band":false}', '{"version":1,"central":"<script>","band":"yes"}']) {
    const odd = await open({}, memory({ 'agentx.iot.reading.v1': raw }));
    assert.equal(odd.iotState.central, 'median'); assert.equal(odd.iotState.ranges, true);
  }
  const denied = await open({}, { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } });
  denied.iotState.central = 'mean'; denied.iotStoreReading();
  assert.equal(denied.iotState.central, 'mean', 'the choice holds for the session');
  assert.equal(posts(page).length + posts(again).length, 0);
});

const form = fields => ({ id: 'iotCommand', fields, dataset: { device: 'SYN_1' }, querySelector() { return { disabled: false }; } });

test('a command is armed first, shows exactly what will be published, and is sent once on confirmation', async () => {
  const page = await open({ devices: [device('SYN_1', { displayName: HOSTILE })] });
  const actions = page.elements['#iotActions'].innerHTML;
  assert.match(actions, /<strong>Attention :<\/strong> les commandes atteignent l’appareil réel\. Un message publié ne confirme pas l’action du matériel\./);
  assert.match(actions, /<button class="button" type="submit">Préparer l’envoi<\/button>/);
  assert.doesNotMatch(actions, /data-iot-command-confirm/);
  await page.iotSubmit(form({ command: 'io_off', gpio: '26' }));
  assert.equal(posts(page).length, 0, 'the first click sends nothing');
  const confirm = page.elements['#iotCommandConfirm'].innerHTML;
  assert.match(confirm, /Voici exactement ce qui sera envoyé/);
  assert.match(confirm, /<dt>Appareil<\/dt><dd>&lt;img src=x onerror=evil\(\)&gt;&quot;&#39; <span class="mono">SYN_1<\/span><\/dd>/);
  assert.match(confirm, /<dt>Commande<\/dt><dd>GPIO OFF<\/dd>/); assert.match(confirm, /<dt>GPIO<\/dt><dd>26<\/dd>/);
  assert.match(confirm, /<dt>Sujet MQTT<\/dt><dd class="mono">esp32\/SYN_1\/io\/off<\/dd>/); assert.match(confirm, /<dt>Contenu<\/dt><dd class="mono">26<\/dd>/);
  assert.match(confirm, /data-iot-command-confirm>Confirmer l’envoi<\/button><button type="button" class="button" data-iot-command-cancel>Annuler/);
  assert.doesNotMatch(confirm, /<img src=x/);
  assert.match(page.iotCommandHtml(page.iotState.devices[0]), /<details class="card" open>/, 'a repaint keeps the armed panel open');
  assert.equal(page.elements['#iotCommandKind'].disabled, true, 'the armed message cannot be edited, only cancelled');
  assert.equal(page.iotRefresher.hold(), 'une commande attend sa confirmation');
  page.click('[data-iot-command-confirm]'); page.click('[data-iot-command-confirm]');
  await settle();
  assert.deepEqual(posts(page).map(call => [call.method, call.path, JSON.parse(JSON.stringify(call.body))]), [['POST', '/iot/devices/SYN_1/commands', { command: 'io_off', gpio: 26 }]]);
  assert.equal(page.iotCommand.armed, null);
  assert.match(page.elements['#iotCommandOutcome'].innerHTML, /data-outcome="sent"><strong>Publié<\/strong> — GPIO OFF publié sur esp32\/SYN_1\/io\/on à .*l’action du matériel n’est pas confirmée/);
  await page.iotSubmit(form({ command: 'reboot' }));
  assert.match(page.elements['#iotCommandConfirm'].innerHTML, /<dt>GPIO<\/dt><dd>aucun<\/dd>.*esp32\/SYN_1\/reboot.*\(vide\)/s);
  page.click('[data-iot-command-confirm]'); await settle();
  assert.deepEqual(JSON.parse(JSON.stringify(posts(page)[1].body)), { command: 'reboot' });
});

test('cancelling, waiting too long, changing device or an invalid GPIO never sends anything', async () => {
  const page = await open({ devices: [device('SYN_1'), device('SYN_2')] });
  await page.iotSubmit(form({ command: 'io_on', gpio: '5' }));
  page.click('[data-iot-command-cancel]');
  assert.equal(page.iotCommand.armed, null);
  assert.match(page.elements['#iotCommandConfirm'].innerHTML, /Envoi annulé\. Rien n’a été envoyé\./);
  page.click('[data-iot-command-confirm]'); await page.iotCommandSend();
  await page.iotSubmit(form({ command: 'io_on', gpio: '5' }));
  const timer = page.timeouts.at(-1);
  assert.equal(timer.ms, 20000); assert.equal(timer.cleared, false);
  timer.callback();
  assert.equal(page.iotCommand.armed, null);
  assert.match(page.elements['#iotCommandConfirm'].innerHTML, /aucune confirmation en 20 secondes\. Rien n’a été envoyé\./);
  await page.iotCommandSend();
  await page.iotSubmit(form({ command: 'io_on', gpio: '5' }));
  await page.iotSelect('SYN_2');
  assert.equal(page.iotCommand.armed, null, 'another device disarms');
  await page.iotCommandSend();
  await page.iotSelect('SYN_1');
  for (const gpio of ['', ' ', '49', '-1', '2.5', '1e1', 'abc', '007']) {
    await page.iotSubmit(form({ command: 'io_on', gpio }));
    assert.equal(page.iotCommand.armed, null, `gpio ${JSON.stringify(gpio)}`);
    assert.match(page.elements['#iotCommandConfirm'].innerHTML, /le GPIO doit être un entier de 0 à 48/);
  }
  await page.iotSubmit(form({ command: 'configIOs', gpio: '1' }));
  assert.equal(page.iotCommand.armed, null);
  assert.equal(posts(page).length, 0);
});

test('commands are disabled with the reason in words when the device or the broker link cannot take them', async () => {
  const cases = [
    [{ devices: [device('SYN_1', { status: 'offline' })] }, 'l’appareil est hors ligne et ne recevrait pas le message'],
    [{ devices: [device('SYN_1', { status: 'stale' })] }, 'l’appareil est silencieux depuis plus de 5 minutes'],
    [{ status: status({ consumer: { configured: true, connected: false } }) }, 'Data n’est pas connecté au broker MQTT'],
    [{ status: status({ consumer: { configured: false, connected: false } }) }, 'le broker MQTT n’est pas configuré sur Data'],
    [{ status: null }, 'l’état du lien MQTT de Data est inconnu']
  ];
  for (const [store, reason] of cases) {
    const page = await open(store);
    const actions = page.elements['#iotActions'].innerHTML;
    assert.ok(actions.includes(`<p class="notice warning" id="iotCommandBlocked">Commandes désactivées : ${reason}.</p>`), reason);
    assert.match(actions, /id="iotCommandKind" disabled>/); assert.match(actions, /id="iotGpio"[^>]* disabled>/); assert.match(actions, /type="submit" disabled>Préparer l’envoi/);
    await page.iotSubmit(form({ command: 'reboot' }));
    assert.equal(page.iotCommand.armed, null);
    assert.ok(page.elements['#iotCommandConfirm'].innerHTML.includes(`Commande non préparée : ${reason}.`));
    await page.iotCommandSend();
    assert.equal(posts(page).length, 0);
  }
  const unknown = await open({ devices: [device('SYN_1', { status: 'unknown' })] });
  assert.equal(unknown.iotCommandBlock(), '', 'a device that never announced its availability can still be commanded');
  const armed = await open();
  await armed.iotSubmit(form({ command: 'reboot' }));
  armed.iotState.devices[0].status = 'offline';
  await armed.iotCommandSend();
  assert.equal(posts(armed).length, 0, 'a device that went offline while armed is not sent to');
  assert.match(armed.elements['#iotCommandOutcome'].innerHTML, /data-outcome="not-sent"><strong>Non envoyé<\/strong> — l’appareil est hors ligne/);
});

test('the outcome tells a refusal (non envoyé) from an unconfirmed publication (peut-être envoyé)', async () => {
  const failure = (code, message) => Object.assign(new Error(message), { status: code });
  const run = async command => {
    const page = await open({ command });
    await page.iotSubmit(form({ command: 'io_on', gpio: '4' }));
    await page.iotCommandSend();
    assert.equal(posts(page).length, 1, 'one request, never repeated');
    assert.equal(page.iotState.pending, false);
    return page.elements['#iotCommandOutcome'].innerHTML;
  };
  assert.match(await run(() => failure(503, 'MQTT broker is not connected. Nothing was sent.')), /data-outcome="not-sent"><strong>Non envoyé<\/strong> — le lien avec le broker n’est pas disponible \(503\)\. MQTT broker is not connected/);
  assert.match(await run(() => failure(404, 'Unknown device')), /data-outcome="not-sent"><strong>Non envoyé<\/strong> — commande refusée \(404\)\. Unknown device/);
  assert.match(await run(() => failure(400, HOSTILE)), /data-outcome="not-sent">.*commande refusée \(400\)\. &lt;img src=x/);
  assert.match(await run(() => failure(504, 'Publish not confirmed within 5 s')), /data-outcome="unknown"><strong>Peut-être envoyé<\/strong> — la publication n’a pas été confirmée à temps \(504\)\. Publish not confirmed within 5 s Vérifie l’appareil avant d’envoyer de nouveau ; aucun nouvel envoi automatique\./);
  assert.match(await run(() => failure(502, 'Command outcome unknown')), /data-outcome="unknown"><strong>Peut-être envoyé<\/strong> — réponse 502 sans confirmation/);
  assert.match(await run(() => ({ throwTransport: true })), /data-outcome="unknown"><strong>Peut-être envoyé<\/strong> — aucune réponse lisible reçue/);
  assert.doesNotMatch(await run(() => failure(400, HOSTILE)), /<img src=x/);
  const page = await open();
  assert.equal(page.iotCommandOutcome(200, { status: 'success', data: { topic: 'esp32/SYN_1/reboot', publishedAt: 'never' } }, { label: 'Redémarrer', topic: 'x' }).text.includes('une heure non précisée'), true);
  assert.equal(page.iotCommandOutcome(200, { status: 'error', message: 'refused late' }, { label: 'x', topic: 'x' }).kind, 'unknown');
});

test('the browser publishes on the same topics as Data', async () => {
  const page = await open();
  assert.deepEqual(Object.keys(page.IOT_COMMANDS), Object.keys(COMMANDS));
  for (const [name, rule] of Object.entries(COMMANDS)) {
    assert.equal(page.IOT_COMMANDS[name].suffix, rule.suffix); assert.equal(page.IOT_COMMANDS[name].gpio, rule.gpio);
  }
});

const event = (type, deviceId, meta = {}, extra = {}) => ({ id: `${type}-${deviceId}-${Math.random()}`, type, severity: type.endsWith('failed') || type.endsWith('stale') ? 'warning' : 'info',
  message: `IoT device ${deviceId} event`, at: ago(120000), meta: { deviceId, displayName: null, location: null, ...meta }, ...extra });

test('the tab lists the selected device’s own IoT events and links to the filtered Activity tab', async () => {
  const events = [
    event('iot.command_sent', 'SYN_1', { command: 'io_on', gpio: 5, topic: 'esp32/SYN_1/io/on' }),
    event('iot.command_failed', 'SYN_1', { command: 'reboot', gpio: null, topic: 'esp32/SYN_1/reboot', error: HOSTILE }),
    event('iot.device_offline', 'SYN_2', { previous: 'online' }),
    event('iot.device_stale', 'SYN_1', { silentForSeconds: 420 }),
    event('iot.device_recovered', 'SYN_1', { previous: 'offline', learnedFromRetained: true }),
    event('iot.device_online', 'SYN_1', { previous: 'unknown' }), event('iot.device_offline', 'SYN_1', { previous: 'online' }),
    event('iot.device_first_seen', 'SYN_1'), event('iot.future_kind', 'SYN_1'), event('iot.device_online', 'SYN_1'), { type: 'iot.device_online', meta: null }
  ];
  const page = await open({ devices: [device('SYN_1'), device('SYN_2')], events, eventTotal: 240 });
  const read = page.requests.find(call => call.path === '/events');
  assert.equal(read.method, 'GET'); assert.deepEqual(Object.fromEntries(read.query), { type: 'iot.', limit: '100' });
  const html = page.elements['#iotEvents'].innerHTML;
  assert.match(html, /<h3>Événements de SYN_1<\/h3>/);
  assert.match(html, /<a href="#activity" data-iot-activity>Ouvrir l’onglet Activity filtré sur l’IoT<\/a>/);
  assert.equal((html.match(/<li /g) || []).length, 8, 'the eight most recent of this device');
  assert.match(html, /<strong>Commande envoyée<\/strong>\s*<span class="iot-event-detail">io_on GPIO 5 → esp32\/SYN_1\/io\/on<\/span>/);
  assert.match(html, /data-severity="warning"><i aria-hidden="true"><\/i><strong>Commande échouée<\/strong>\s*<span class="iot-event-detail">reboot → esp32\/SYN_1\/reboot · &lt;img src=x/);
  assert.match(html, /<strong>Silencieux<\/strong>\s*<span class="iot-event-detail">silencieux depuis 7 min/);
  assert.match(html, /<strong>De retour<\/strong>\s*<span class="iot-event-detail">état précédent : hors ligne · appris d’un message retenu/);
  assert.match(html, /<strong>Vu pour la première fois<\/strong>/); assert.match(html, /<strong>iot\.future_kind<\/strong>/);
  assert.match(html, /8 affichés sur 9 pour cet appareil\. Lecture des 11 événements IoT les plus récents sur 240 ; Data garde 30 jours\./);
  assert.doesNotMatch(html, /<img src=x/);
  await page.iotSelect('SYN_2'); await settle();
  assert.equal((page.elements['#iotEvents'].innerHTML.match(/<li /g) || []).length, 1);
  assert.match(page.elements['#iotEvents'].innerHTML, /<strong>Hors ligne<\/strong>/);
  Object.assign(page.activityState, { family: 'storage', severity: 'error', page: 4 });
  page.click('[data-iot-activity]');
  assert.deepEqual([page.activityState.family, page.activityState.severity, page.activityState.page], ['iot', '', 1]);
  assert.equal(posts(page).length, 0);
});

test('an empty or unreadable journal says so and the rest of the tab stays usable', async () => {
  const quiet = await open({ events: [] });
  assert.match(quiet.elements['#iotEvents'].innerHTML, /Aucun événement récent pour cet appareil\./);
  assert.match(quiet.elements['#iotEvents'].innerHTML, /Le journal ne contient aucun événement IoT ; Data garde 30 jours\./);
  const one = await open({ events: [event('iot.device_first_seen', 'SYN_1')] });
  assert.match(one.elements['#iotEvents'].innerHTML, /Le journal ne contient qu’un événement IoT/);
  const down = await open({ events: Object.assign(new Error(HOSTILE), { status: 502 }) });
  assert.match(down.elements['#iotEvents'].innerHTML, /role="alert">Journal indisponible : &lt;img src=x/);
  assert.match(down.elements['#iotCards'].innerHTML, /SYN_1/);
  assert.match(down.elements['#iotActions'].innerHTML, /Préparer l’envoi/);
});

test('the "not back yet" note is collapsed text with no control', async () => {
  const page = await open();
  const note = page.iotMissingHtml();
  assert.match(note, /^<details class="card iot-missing"><summary>Pas encore revenu des anciennes pages<\/summary>/);
  assert.doesNotMatch(note, /<details[^>]* open/);
  assert.equal((note.match(/<li>/g) || []).length, 3);
  assert.match(note, /Minuteries quotidiennes par sortie.*Timerz.*côté serveur.*côté appareil/s);
  assert.match(note, /Profils de configuration des entrées\/sorties.*côté serveur/s);
  assert.match(note, /Caméras.*côté serveur/s);
  assert.doesNotMatch(note, /<button|<a |<input|<select|data-iot-/);
  assert.ok(page.elements['#content'].innerHTML.includes(note));
});
