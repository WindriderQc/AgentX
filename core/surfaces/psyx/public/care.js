'use strict';

// PsyX care cues: crisis resources when the server detects a crisis signal. Loaded
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

function wireCare() {
  $('safetyClose').addEventListener('click', hideSafety);
}
