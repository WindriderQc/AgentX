'use strict';

// Commands of the IoT tab. Sending takes two clicks: the first one arms a
// command and shows exactly what will be published, the second one sends that
// frozen message. Cancelling, changing the form or the device, or waiting too
// long disarms it. Nothing here retries: one confirmation is one request.

// The same topics as Data (shared/iotDeviceRules.js); a test keeps them equal.
const IOT_COMMANDS = Object.freeze({
  io_on: { label: 'GPIO ON', suffix: 'io/on', gpio: true },
  io_off: { label: 'GPIO OFF', suffix: 'io/off', gpio: true },
  reboot: { label: 'Reboot', suffix: 'reboot', gpio: false }
});
const IOT_COMMAND_ARM_MS = 20000;
const iotCommand = { armed: null, timer: null, outcome: null, note: '' };

/** Why no command can be sent now, in words, or '' when one can. */
function iotCommandBlock(device = iotDevice(), status = iotState.status) {
  const consumer = status?.consumer;
  if (!consumer) return 'the state of Data’s MQTT link is unknown';
  if (!consumer.configured) return 'the MQTT broker is not configured on Data';
  if (!consumer.connected) return 'Data is not connected to the MQTT broker';
  if (device?.status === 'offline') return 'the device is offline and would not receive the message';
  if (device?.status === 'stale') {
    const minutes = Math.round(Number(status.settings?.staleAfterSeconds) / 60);
    return `the device has been silent for more than ${Number.isFinite(minutes) && minutes > 0 ? minutes : 5} minutes`;
  }
  return '';
}

function iotCommandDisarm(note = '') {
  if (iotCommand.timer) clearTimeout(iotCommand.timer);
  Object.assign(iotCommand, { armed: null, timer: null, note });
}

/** First step: freeze the message and show it. Returns the refusal, or '' when armed. */
function iotCommandArm(id, fields) {
  iotCommandDisarm(); iotCommand.outcome = null;
  const device = iotDevice();
  if (!device || device.id !== id) return 'Device changed: command not prepared.';
  const blocked = iotCommandBlock(device);
  if (blocked) return `Command not prepared: ${blocked}.`;
  const kind = Object.hasOwn(IOT_COMMANDS, fields.command) ? IOT_COMMANDS[fields.command] : null;
  if (!kind) return 'Unknown command.';
  const text = String(fields.gpio ?? '').trim(); const gpio = Number(text);
  if (kind.gpio && (!/^\d{1,2}$/.test(text) || gpio > 48)) return 'Command not prepared: the GPIO must be an integer from 0 to 48.';
  iotCommand.armed = { id, name: device.displayName || device.id, command: fields.command, label: kind.label,
    gpio: kind.gpio ? gpio : null, topic: `esp32/${id}/${kind.suffix}`, payload: kind.gpio ? String(gpio) : '' };
  iotCommand.timer = setTimeout(() => {
    iotCommandDisarm('Send cancelled: no confirmation within 20 seconds. Nothing was sent.'); iotPaintCommand();
  }, IOT_COMMAND_ARM_MS);
  return '';
}

function iotCommandConfirmHtml() {
  const armed = iotCommand.armed;
  if (!armed) return iotCommand.note ? `<p class="muted">${e(iotCommand.note)}</p>` : '';
  return `<div class="iot-confirm" role="group" aria-label="Command confirmation"><strong>Exactly this will be sent:</strong><dl>
    <div><dt>Device</dt><dd>${armed.name === armed.id ? '' : `${e(armed.name)} `}<span class="mono">${e(armed.id)}</span></dd></div>
    <div><dt>Command</dt><dd>${e(armed.label)}</dd></div>
    <div><dt>GPIO</dt><dd>${armed.gpio === null ? 'none' : e(String(armed.gpio))}</dd></div>
    <div><dt>MQTT topic</dt><dd class="mono">${e(armed.topic)}</dd></div>
    <div><dt>Payload</dt><dd class="mono">${armed.payload === '' ? '(empty)' : e(armed.payload)}</dd></div></dl>
    <p class="muted">QoS 0, not retained, never queued. Without confirmation within 20 seconds, nothing is sent.</p>
    <div class="iot-confirm-buttons"><button type="button" class="button iot-danger" data-iot-command-confirm${iotState.pending ? ' disabled' : ''}>Confirm send</button><button type="button" class="button" data-iot-command-cancel${iotState.pending ? ' disabled' : ''}>Cancel</button></div></div>`;
}

function iotCommandOutcomeHtml() {
  const outcome = iotCommand.outcome;
  if (!outcome) return '';
  const lead = { sent: 'Published', 'not-sent': 'Not sent', unknown: 'Maybe sent', sending: 'Sending' }[outcome.kind];
  return `<p class="iot-outcome" data-outcome="${outcome.kind}"><strong>${lead}</strong> — ${e(outcome.text)}</p>`;
}

function iotCommandHtml(device) {
  const blocked = iotCommandBlock(device);
  const off = blocked || iotState.pending || iotCommand.armed ? ' disabled' : '';
  return `<details class="card"${iotCommand.armed || iotCommand.outcome?.kind === 'sending' ? ' open' : ''}><summary>Commands for ${e(device.displayName || device.id)}</summary>
    <p class="iot-caution"><strong>Caution:</strong> commands reach the real device. A published message does not confirm the hardware action.</p>
    ${blocked ? `<p class="notice warning" id="iotCommandBlocked">Commands disabled: ${e(blocked)}.</p>` : ''}
    <form id="iotCommand" data-device="${e(device.id)}"><label>Command<select name="command" id="iotCommandKind"${off}>${Object.entries(IOT_COMMANDS).map(([value, kind]) => `<option value="${value}"${iotCommand.armed?.command === value ? ' selected' : ''}>${kind.label}</option>`).join('')}</select></label>
    <label id="iotGpioLabel"${iotCommand.armed?.gpio === null ? ' hidden' : ''}>GPIO<input type="number" name="gpio" id="iotGpio" min="0" max="48" step="1" placeholder="GPIO number"${iotCommand.armed ? ` value="${e(iotCommand.armed.payload)}"` : ''} required${off}></label><button class="button" type="submit"${off}>Prepare send</button></form>
    <div id="iotCommandConfirm" aria-live="polite">${iotCommandConfirmHtml()}</div><div id="iotCommandOutcome" role="status">${iotCommandOutcomeHtml()}</div></details>`;
}

function iotPaintCommand() {
  if (state.tab !== 'iot') return;
  const confirm = document.querySelector('#iotCommandConfirm'); if (confirm) confirm.innerHTML = iotCommandConfirmHtml();
  const outcome = document.querySelector('#iotCommandOutcome'); if (outcome) outcome.innerHTML = iotCommandOutcomeHtml();
  const off = Boolean(iotCommandBlock() || iotState.pending || iotCommand.armed);
  for (const selector of ['#iotCommandKind', '#iotGpio', '#iotCommand [type="submit"]']) {
    const control = document.querySelector(selector); if (control) control.disabled = off;
  }
}

/** What an answer to the POST means for the device: published, not sent, or unknown. */
function iotCommandOutcome(status, body, armed) {
  const message = typeof body?.message === 'string' ? body.message.slice(0, 300) : '';
  if (status >= 200 && status < 300 && body && body.ok !== false && body.status !== 'error') {
    const data = body.data ?? body; const at = new Date(data.publishedAt);
    return { kind: 'sent', text: `${armed.label} published to ${data.topic || armed.topic} at ${Number.isFinite(at.getTime()) ? at.toLocaleTimeString() : 'an unspecified time'}. The device sends no reply: the hardware action is not confirmed.` };
  }
  // 4xx and 503 are refusals made before any publication. Everything else
  // (504, a lost reply, an unreadable answer) leaves the publication unknown.
  if (status === 503) return { kind: 'not-sent', text: `the broker link is not available (503). ${message}`.trim() };
  if (status >= 400 && status < 500) return { kind: 'not-sent', text: `command refused (${status}). ${message}`.trim() };
  return { kind: 'unknown', text: `${status === 504 ? 'the publication was not confirmed in time (504)' : status ? `response ${status} without confirmation` : 'no readable response received'}. ${message} Check the device before sending again; nothing is resent automatically.`.replace(/\s+/g, ' ') };
}

/** Second step: send the armed message once. */
async function iotCommandSend() {
  const armed = iotCommand.armed;
  if (!armed || iotState.pending || state.tab !== 'iot' || armed.id !== iotState.selected) return;
  const blocked = iotCommandBlock();
  iotCommandDisarm();
  if (blocked) { iotCommand.outcome = { kind: 'not-sent', text: `${blocked}.` }; iotPaintCommand(); return; }
  const seq = state.renderSeq;
  iotState.pending = true;
  iotCommand.outcome = { kind: 'sending', text: `${armed.label} to ${armed.topic}…` };
  iotPaintCommand();
  let outcome;
  try {
    const response = await fetch(`/api/data-toolbox${iotPath(armed.id)}/commands`, { method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: armed.command, ...(armed.gpio === null ? {} : { gpio: armed.gpio }) }) });
    let body = null;
    try { body = await response.json(); } catch { /* An unreadable answer leaves the outcome unknown. */ }
    outcome = iotCommandOutcome(body ? response.status : response.ok ? 0 : response.status, body, armed);
  } catch { outcome = iotCommandOutcome(0, null, armed); }
  iotState.pending = false;
  iotCommand.outcome = { ...outcome, device: armed.id };
  if (seq === state.renderSeq && state.tab === 'iot') { iotPaintCommand(); if (typeof iotLoadEvents === 'function') iotLoadEvents(true); }
}

document.addEventListener('click', event => {
  if (state.tab !== 'iot') return;
  if (event.target.closest('[data-iot-command-confirm]')) iotCommandSend();
  else if (event.target.closest('[data-iot-command-cancel]')) { iotCommandDisarm('Send cancelled. Nothing was sent.'); iotPaintCommand(); }
});
