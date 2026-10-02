'use strict';

// PsyX care cues: crisis resources when the server detects a crisis signal,
// and a recap of the last session when a new conversation starts. Loaded
// before app.js, whose shared state and helpers these functions use at call time.

const TEL = { '911': '911', '9-8-8': '988', '1 866 APPELLE (277-3553)': '18662773553', '8-1-1': '811' };

function showSafety(resources = []) {
  const banner = $('safetyBanner');
  $('safetyResources').innerHTML = resources.map((item) => `
    <li><a href="tel:${escapeHtml(TEL[item.contact] || item.contact.replace(/[^0-9]/g, ''))}">${escapeHtml(item.contact)}</a><span>${escapeHtml(item.label)}</span></li>
  `).join('');
  banner.hidden = false;
}

function hideSafety() {
  $('safetyBanner').hidden = true;
}

// Only a new conversation shows the recap; PsyX itself decides whether to bring it up.
function renderOpening() {
  const recap = $('openingRecap');
  const last = (state.psyxState?.sessionDigests || []).at(-1);
  const experiments = (state.psyxState?.experiments || []).filter((item) => ['planned', 'active'].includes(item.status)).slice(-2);
  if (state.conversationId || (!last && !experiments.length)) {
    recap.hidden = true;
    return;
  }
  recap.innerHTML = [
    last ? `<p><strong>La dernière fois :</strong> ${escapeHtml(last.summary)}${last.commitment ? ` <em>Tu voulais : ${escapeHtml(last.commitment)}</em>` : ''}</p>` : '',
    ...experiments.map((item) => `<p><strong>Expérience en cours :</strong> ${escapeHtml(item.action)}</p>`)
  ].join('');
  recap.hidden = false;
}

function wireCare() {
  $('safetyClose').addEventListener('click', hideSafety);
}
