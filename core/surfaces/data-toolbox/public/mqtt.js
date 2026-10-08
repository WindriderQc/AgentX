'use strict';

// The Toolbox MQTT tab. Loaded before app.js, whose helpers (state, api, e,
// heading, number, bytes, date, ageLabel…) it uses when called.
// It reads Data's broker monitor (status and the messages after the last one
// seen) every two seconds while the tab is open and visible, and sends the
// second of the page's two writes: one MQTT message published by hand.
// Topics and payloads come from the network: they are always escaped.

const MQTT_POLL_MS = 2000;
const MQTT_MAX_ROWS = 300;
const MQTT_READS_PER_POLL = 3;
const MQTT_MAX_TOPIC_BYTES = 256;
const MQTT_MAX_PAYLOAD_BYTES = 4096;
const MQTT_LONG_PAYLOAD = 200;
const MQTT_QUICK_FILTERS = Object.freeze(['#', 'esp32/#', 'liveData/#', 'sensors/#']);

const mqttState = {
  status: null, rows: [], since: null, lastSeq: 0, epoch: null, filter: '#', filterError: '', paused: false,
  notice: '', streamError: '', loaded: false, busy: false, timer: null, open: new Set(),
  sending: false, outcome: null, draft: { topic: 'esp32/', payload: '', retain: false }
};

const mqttBytes = (text) => new TextEncoder().encode(text).length;
const mqttSettled = (promise) => promise.then((data) => ({ data }), (error) => ({ error: error.message }));
const mqttClock = (value) => {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? '—' : parsed.toLocaleTimeString();
};

// The same refusals, in the same words, as Data (shared/mqttTopicRules.js).
function mqttPublishProblem(topic, payload) {
  if (typeof topic !== 'string' || !topic.length) return 'topic must be a non-empty string';
  if (mqttBytes(topic) > MQTT_MAX_TOPIC_BYTES) return `topic must be at most ${MQTT_MAX_TOPIC_BYTES} bytes`;
  if (topic.includes('\u0000')) return 'topic must not contain a NUL character';
  if (typeof topic.isWellFormed === 'function' && !topic.isWellFormed()) return 'topic must be valid Unicode text';
  if (/[#+]/.test(topic)) return 'topic must not contain the wildcards # or +';
  if (topic.startsWith('$')) return 'topic must not start with $ (reserved for the broker)';
  if (typeof payload !== 'string') return 'payload must be a string (it may be empty)';
  if (mqttBytes(payload) > MQTT_MAX_PAYLOAD_BYTES) return `payload must be at most ${MQTT_MAX_PAYLOAD_BYTES} bytes`;
  return '';
}

function mqttFilterProblem(filter) {
  if (typeof filter !== 'string' || !filter.length) return 'topic filter must be a non-empty string';
  if (mqttBytes(filter) > MQTT_MAX_TOPIC_BYTES) return `topic filter must be at most ${MQTT_MAX_TOPIC_BYTES} bytes`;
  if (filter.includes('\u0000')) return 'topic filter must not contain a NUL character';
  const levels = filter.split('/');
  for (let index = 0; index < levels.length; index++) {
    if (levels[index].includes('#') && (levels[index] !== '#' || index !== levels.length - 1)) return 'in a topic filter, # must be alone in the last level';
    if (levels[index].includes('+') && levels[index] !== '+') return 'in a topic filter, + must fill a whole level';
  }
  return '';
}

function mqttPaint(selector, html) {
  const target = document.querySelector(selector);
  if (target && state.tab === 'mqtt') target.innerHTML = html;
}

function mqttStatusSection() {
  const { data, error } = mqttState.status || {};
  if (error) return `<div class="notice warning"><strong>Data unavailable.</strong> The broker state could not be read from Data: ${e(error)}. Nothing can be read or sent until Data answers.</div>`;
  if (!data) return '<p class="muted">Reading the broker state…</p>';
  if (data.configured !== true) {
    return `<div class="notice warning"><strong>Broker not configured.</strong> Data has no MQTT broker to connect to. Set <code>MQTT_BROKER_URL</code> in Data's environment (with <code>MQTT_USERNAME</code> and <code>MQTT_PASSWORD</code> when the broker has accounts) and restart Data. Until then there is no stream and nothing can be sent.</div>`;
  }
  const connected = data.connected === true;
  return `<article class="card">
    <div class="card-title"><h3>Broker</h3><span class="pill ${connected ? 'good' : 'warn'}">${connected ? 'connected' : 'not connected'}</span></div>
    ${connected ? '' : '<div class="notice warning"><strong>Not connected.</strong> Data retries on its own every few seconds. Nothing is received meanwhile, and a message sent now is refused, not queued.</div>'}
    <div class="metric-row"><span>Broker</span><strong class="mono">${e(data.broker || 'unknown')}</strong></div>
    <div class="metric-row"><span>Messages received</span><strong>${number(data.received)} <span class="muted">since ${date(data.since)}</span></strong></div>
    <div class="metric-row"><span>Last message</span><strong>${data.lastMessageAt ? `${date(data.lastMessageAt)} <span class="muted">${e(ageLabel(data.lastMessageAt))}</span>` : 'none yet'}</strong></div>
    ${data.lastError ? `<div class="metric-row"><span>Last error</span><strong class="bad">${e(data.lastError)}</strong></div>` : ''}
  </article>`;
}

function mqttControls() {
  const shown = `${number(mqttState.rows.length)} message${mqttState.rows.length === 1 ? '' : 's'} shown`;
  return `<button type="button" class="button" data-mqtt-action="pause" aria-pressed="${mqttState.paused}">${mqttState.paused ? 'Resume' : 'Pause'}</button>
    <button type="button" class="button" data-mqtt-action="clear">Clear</button>
    <span class="muted">${shown} · filter <span class="mono">${e(mqttState.filter)}</span> · ${mqttState.paused
    ? '<strong class="warn">paused</strong>: nothing is read until Resume, Data keeps its own buffer'
    : `read every ${MQTT_POLL_MS / 1000} s while this tab is open and visible`}</span>`;
}

function mqttNotices() {
  return `${mqttState.filterError ? `<div class="notice warning">Filter not applied: ${e(mqttState.filterError)}.</div>` : ''}
    ${mqttState.streamError ? `<div class="notice warning">The stream could not be read from Data: ${e(mqttState.streamError)}. The rows below are the last ones read.</div>` : ''}
    ${mqttState.notice ? `<div class="notice warning">${e(mqttState.notice)}</div>` : ''}`;
}

function mqttPayloadCell(message) {
  const text = String(message.payload ?? '');
  if (!text.length) return '<span class="muted">(empty)</span>';
  const body = `<pre class="mqtt-payload">${e(text)}</pre>`;
  if (text.length <= MQTT_LONG_PAYLOAD && text.split('\n').length <= 4) return body;
  const preview = text.slice(0, 100).replace(/\s+/g, ' ');
  return `<details data-mqtt-seq="${e(message.seq)}"${mqttState.open.has(String(message.seq)) ? ' open' : ''}><summary class="mono">${e(preview)}…</summary>${body}</details>`;
}

function mqttRow(message) {
  const flags = [
    message.retained ? '<span class="pill warn">retained</span>' : '',
    message.binary ? '<span class="pill">binary, shown as hex</span>' : '',
    message.truncated ? '<span class="pill">cut for display</span>' : ''
  ].filter(Boolean).join(' ');
  return `<tr><td title="${e(date(message.ts))}">${e(mqttClock(message.ts))}</td>
    <td class="mono">${e(message.topic)}</td>
    <td>${mqttPayloadCell(message)}</td>
    <td>${bytes(message.bytes)}</td>
    <td>${flags || '<span class="muted">—</span>'}</td></tr>`;
}

function mqttStreamSection() {
  const configured = mqttState.status?.data ? mqttState.status.data.configured === true : true;
  const empty = !configured ? 'No broker is configured on Data, so there is no stream.'
    : mqttState.paused ? 'Paused with an empty list.'
      : `No message on ${mqttState.filter} yet. New ones appear here as they arrive.`;
  return `<div class="table-wrap mqtt-stream" tabindex="0" role="region" aria-label="MQTT messages, newest first"><table><thead><tr><th scope="col">Time</th><th scope="col">Topic</th><th scope="col">Payload</th><th scope="col">Size</th><th scope="col">Flags</th></tr></thead><tbody>
    ${mqttState.rows.length ? mqttState.rows.map(mqttRow).join('') : noRows(5, empty)}
  </tbody></table></div>`;
}

function mqttOutcomeSection() {
  const outcome = mqttState.outcome;
  if (!outcome) return '';
  return `<div class="notice ${outcome.ok ? 'success' : 'warning'}">${e(outcome.text)}</div>`;
}

function mqttSyncSend() {
  const button = document.querySelector('#mqttSendButton');
  if (!button || state.tab !== 'mqtt') return;
  const broker = mqttState.status?.data;
  button.disabled = mqttState.sending || Boolean(broker && (broker.configured !== true || broker.connected !== true));
  button.textContent = mqttState.sending ? 'Sending…' : 'Send';
}

function mqttPaintStream() {
  mqttPaint('#mqttControls', mqttControls());
  mqttPaint('#mqttNotice', mqttNotices());
  mqttPaint('#mqttStream', mqttStreamSection());
}

// Reads what arrived after the last message seen. Data answers at most 300
// messages at a time; a burst is caught up over a few reads, and what Data's
// buffer no longer holds is reported instead of silently skipped.
async function mqttReadNew(seq) {
  for (let read = 0; read < MQTT_READS_PER_POLL; read++) {
    const query = new URLSearchParams({ limit: String(MQTT_MAX_ROWS), topic: mqttState.filter });
    if (mqttState.since !== null) query.set('since', String(mqttState.since));
    const filter = mqttState.filter;
    const result = await mqttSettled(api(`/mqtt/messages?${query}`));
    if (seq !== state.renderSeq || state.tab !== 'mqtt' || filter !== mqttState.filter) return false;
    if (result.error) { mqttState.streamError = result.error; return true; }
    const data = result.data || {};
    mqttState.streamError = '';
    if (mqttState.epoch !== null && data.epoch !== mqttState.epoch) {
      // Data restarted: its sequence numbers start again. Read the list anew.
      Object.assign(mqttState, { epoch: data.epoch, since: null, lastSeq: 0, rows: [], open: new Set(),
        notice: `Data restarted its broker monitor (${mqttClock(data.epoch)}): the list starts again from what it has received since.` });
      continue;
    }
    mqttState.epoch = data.epoch ?? null;
    if (data.dropped) {
      mqttState.notice = `Noticed at ${mqttClock(Date.now())}: ${number(data.droppedCount)} message${data.droppedCount === 1 ? '' : 's'} passed between two reads and ${data.droppedCount === 1 ? 'is' : 'are'} no longer in Data's buffer (it keeps the last ${number(data.bufferSize)}). They are not shown${mqttState.filter === '#' ? '' : '; with a topic filter, some of them may not have matched'}.`;
    }
    // Two reads may overlap (a filter change during a poll): a message is
    // listed once.
    const fresh = array(data.messages).filter((message) => message.seq > mqttState.lastSeq).reverse();
    if (fresh.length) mqttState.lastSeq = fresh[0].seq;
    mqttState.rows = [...fresh, ...mqttState.rows].slice(0, MQTT_MAX_ROWS);
    mqttState.since = Number.isSafeInteger(data.nextSince) ? data.nextSince : mqttState.since;
    if (!data.more) break;
  }
  return true;
}

async function mqttTab() {
  const seq = state.renderSeq;
  mqttState.status = await mqttSettled(api('/mqtt/status'));
  if (seq !== state.renderSeq || state.tab !== 'mqtt') return;
  if (!mqttState.paused && !mqttState.status.error && !(await mqttReadNew(seq))) return;
  mqttState.loaded = true;
  const draft = mqttState.draft;
  content.innerHTML = `${heading('MQTT', 'The messages passing on the house broker, seen through Data\'s own connection, and a form to publish one by hand.', '<button class="button" data-action="refresh">Refresh</button>')}
    <section id="mqttStatus" aria-live="off">${mqttStatusSection()}</section>
    ${heading('Stream', `Newest first. This page keeps the last ${MQTT_MAX_ROWS} messages it has read; nothing here is stored.`)}
    <form id="mqttFilter" class="mqtt-filter">
      <label for="mqttFilterInput">Topic filter</label>
      <input id="mqttFilterInput" name="topic" class="mono" value="${e(mqttState.filter)}" maxlength="256" autocomplete="off" spellcheck="false" aria-describedby="mqttFilterHelp">
      <button class="button" type="submit">Apply</button>
      ${MQTT_QUICK_FILTERS.map((filter) => `<button type="button" class="button mono" data-mqtt-filter="${e(filter)}">${e(filter)}</button>`).join('')}
    </form>
    <p id="mqttFilterHelp" class="muted mqtt-help">MQTT wildcards: <span class="mono">+</span> stands for one level, <span class="mono">#</span> for everything below. Data applies the filter; the broker's own <span class="mono">$SYS</span> topics are not part of <span class="mono">#</span>.</p>
    <div id="mqttControls" class="mqtt-controls">${mqttControls()}</div>
    <div id="mqttNotice" aria-live="polite">${mqttNotices()}</div>
    <section id="mqttStream" aria-live="off">${mqttStreamSection()}</section>
    ${heading('Send', 'Publish one message through Data, at QoS 0, on any topic.')}
    <div class="notice warning" role="note"><strong>These messages reach real devices.</strong> A message can switch an output or reboot a device the moment it is sent. There is no confirmation step and no undo.</div>
    <form id="mqttSend" class="mqtt-send">
      <label for="mqttTopic">Topic</label>
      <input id="mqttTopic" name="topic" class="mono" value="${e(draft.topic)}" maxlength="256" autocomplete="off" spellcheck="false" required>
      <label for="mqttPayload">Message</label>
      <textarea id="mqttPayload" name="payload" class="mono" rows="4" spellcheck="false">${e(draft.payload)}</textarea>
      <label class="mqtt-retain"><input type="checkbox" name="retain"${draft.retain ? ' checked' : ''}> Retain <span class="muted">— the broker keeps a retained message and delivers it again to every device that subscribes later.</span></label>
      <div><button class="button" type="submit" id="mqttSendButton">Send</button></div>
    </form>
    <div id="mqttOutcome" role="status" aria-live="polite">${mqttOutcomeSection()}</div>`;
  mqttSyncSend();
  if (!mqttState.timer) mqttState.timer = setInterval(mqttPoll, MQTT_POLL_MS);
}

// The timer stops at its first tick on another tab and asks nothing while the
// page is hidden. An answer is written only into the MQTT tab that asked for
// it: a tab change or a newer render makes it stale and it is dropped. The
// send form is never repainted here, so what is being typed stays.
async function mqttPoll() {
  if (state.tab !== 'mqtt') {
    clearInterval(mqttState.timer);
    mqttState.timer = null;
    return;
  }
  if (!mqttState.loaded || mqttState.busy || document.hidden === true) return;
  const seq = state.renderSeq;
  mqttState.busy = true;
  try {
    const status = await mqttSettled(api('/mqtt/status'));
    if (seq !== state.renderSeq || state.tab !== 'mqtt') return;
    mqttState.status = status;
    mqttPaint('#mqttStatus', mqttStatusSection());
    mqttSyncSend();
    if (mqttState.paused) return;
    if (status.error) mqttState.streamError = status.error;
    else if (!(await mqttReadNew(seq))) return;
    mqttPaintStream();
    updated.textContent = `updated ${new Date().toLocaleTimeString()}`;
  } finally { mqttState.busy = false; }
}

async function mqttSetFilter(value) {
  if (state.tab !== 'mqtt' || !mqttState.loaded) return;
  const filter = String(value ?? '').trim();
  const input = document.querySelector('#mqttFilterInput');
  mqttState.filterError = mqttFilterProblem(filter);
  if (mqttState.filterError) { mqttPaint('#mqttNotice', mqttNotices()); return; }
  if (input) input.value = filter;
  // A new filter is a new list: the newest matching messages Data still holds.
  Object.assign(mqttState, { filter, rows: [], since: null, lastSeq: 0, notice: '', streamError: '', open: new Set() });
  mqttPaintStream();
  if (mqttState.paused) return;
  const seq = state.renderSeq;
  if (await mqttReadNew(seq)) mqttPaintStream();
}

function mqttTogglePause() {
  if (state.tab !== 'mqtt' || !mqttState.loaded) return;
  mqttState.paused = !mqttState.paused;
  mqttPaintStream();
  if (!mqttState.paused) mqttPoll();
}

// Clears this page's list only: Data's buffer and the broker are untouched.
function mqttClear() {
  if (state.tab !== 'mqtt' || !mqttState.loaded) return;
  Object.assign(mqttState, { rows: [], notice: '', open: new Set() });
  mqttPaintStream();
}

async function mqttSend({ topic, payload, retain }) {
  if (mqttState.sending || state.tab !== 'mqtt') return;
  mqttState.draft = { topic, payload, retain: retain === true };
  const problem = mqttPublishProblem(topic, payload);
  if (problem) {
    mqttState.outcome = { ok: false, text: `Not sent: ${problem}.` };
    mqttPaint('#mqttOutcome', mqttOutcomeSection());
    return;
  }
  mqttState.sending = true;
  mqttState.outcome = null;
  mqttPaint('#mqttOutcome', '');
  mqttSyncSend();
  try {
    const sent = await api('/mqtt/publish', { method: 'POST', payload: { topic, payload, retain: retain === true } });
    mqttState.outcome = { ok: true, text: `Sent to ${sent.topic ?? topic} at ${mqttClock(sent.publishedAt || Date.now())} · ${bytes(sent.bytes ?? mqttBytes(payload))}${sent.retain ? ' · retained' : ''}. It appears in the stream when the broker delivers it back.` };
  } catch (error) {
    mqttState.outcome = { ok: false, text: `Not sent: ${error.message}` };
  } finally {
    mqttState.sending = false;
  }
  mqttPaint('#mqttOutcome', mqttOutcomeSection());
  mqttSyncSend();
  // The message is not added to the list here: it shows up through the next
  // read, like any other, once the broker has delivered it to Data.
  if (mqttState.outcome.ok) mqttPoll();
}

document.addEventListener('click', (event) => {
  const filter = event.target.closest?.('[data-mqtt-filter]')?.dataset.mqttFilter;
  if (filter) mqttSetFilter(filter);
  const action = event.target.closest?.('[data-mqtt-action]')?.dataset.mqttAction;
  if (action === 'pause') mqttTogglePause();
  if (action === 'clear') mqttClear();
});

document.addEventListener('submit', (event) => {
  if (event.target.id !== 'mqttFilter' && event.target.id !== 'mqttSend') return;
  event.preventDefault();
  const fields = event.target.elements;
  if (event.target.id === 'mqttFilter') mqttSetFilter(fields.topic.value);
  else mqttSend({ topic: fields.topic.value, payload: fields.payload.value, retain: fields.retain.checked === true });
});

// What is typed survives a full redraw of the tab (Refresh, tab change).
document.addEventListener('input', (event) => {
  if (event.target.form?.id !== 'mqttSend') return;
  const fields = event.target.form.elements;
  mqttState.draft = { topic: fields.topic.value, payload: fields.payload.value, retain: fields.retain.checked === true };
});

// `toggle` does not bubble: listen in the capture phase. An expanded payload
// stays expanded when new messages redraw the table.
document.addEventListener('toggle', (event) => {
  const seq = event.target.dataset?.mqttSeq;
  if (!seq) return;
  if (event.target.open) mqttState.open.add(seq); else mqttState.open.delete(seq);
}, true);

document.addEventListener('visibilitychange', () => { mqttPoll(); });
