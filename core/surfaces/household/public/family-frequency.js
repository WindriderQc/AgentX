/* Family routine frequency: labels and the every-N-days fields (#863). */
(function () {
  'use strict';
  const labels = { once: 'One-time', daily: 'Every day', weekly: 'Every week', interval: 'Every N days' };
  const LIMITS = { min: 2, max: 90 };
  const days = value => {
    const number = Number(value);
    return Number.isInteger(number) && number >= LIMITS.min && number <= LIMITS.max ? number : null;
  };

  /** Parent wording for a projected chore. */
  function label(chore = {}) {
    if (chore.cadence !== 'interval' || !chore.intervalDays) return labels[chore.cadence] || labels.once;
    const winter = chore.winterIntervalDays && chore.winterIntervalDays !== chore.intervalDays
      ? ` (${chore.winterIntervalDays} in winter)` : '';
    return `Every ${chore.intervalDays} days${winter}`;
  }

  /** Short wording for the Kids Room: the interval in force today. */
  function kidLabel(chore = {}) {
    if (chore.cadence === 'interval') return `every ${chore.currentIntervalDays || chore.intervalDays} days`;
    return chore.cadence === 'daily' ? 'every day' : chore.cadence === 'weekly' ? 'every week' : 'once';
  }

  function options(selected = 'once') {
    return Object.entries(labels).map(([value, text]) => `<option value="${value}"${value === selected ? ' selected' : ''}>${text}</option>`).join('');
  }

  /** The interval fields, shown only while the frequency is "Every N days". */
  function fields() {
    return `<label data-frequency-interval hidden><span>Every (days)</span><input name="intervalDays" type="number" min="${LIMITS.min}" max="${LIMITS.max}" step="1" inputmode="numeric" value="7"><small data-frequency-hint class="muted" aria-live="polite"></small></label>`
      + `<label data-frequency-interval hidden><span>In winter (optional)</span><input name="winterIntervalDays" type="number" min="${LIMITS.min}" max="${LIMITS.max}" step="1" inputmode="numeric" placeholder="Same"></label>`;
  }

  function nextDay(today, offset) {
    const date = new Date(`${today}T12:00:00Z`); date.setUTCDate(date.getUTCDate() + offset);
    return new Intl.DateTimeFormat('en-CA', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }).format(date);
  }

  /** Shows the fields for "interval" and previews the next due day after an approval today. */
  function bind(root, select, today = () => new Date().toISOString().slice(0, 10)) {
    const every = root.querySelector('[name="intervalDays"]'), winter = root.querySelector('[name="winterIntervalDays"]');
    const hint = root.querySelector('[data-frequency-hint]');
    const sync = () => {
      const on = select.value === 'interval';
      root.querySelectorAll('[data-frequency-interval]').forEach(node => { node.hidden = !on; });
      every.required = on;
      const value = days(every.value), winterValue = days(winter.value);
      hint.textContent = on && value
        ? `Approved today → due again ${nextDay(today(), value)}${winterValue ? ` (${winterValue} days later in winter)` : ''}.` : '';
    };
    select.addEventListener('change', sync); every.addEventListener('input', sync); winter.addEventListener('input', sync);
    sync();
    return sync;
  }

  /** Fills the fields from a chore before editing it. */
  function fill(root, chore = {}) {
    root.querySelector('[name="intervalDays"]').value = chore.intervalDays || 7;
    root.querySelector('[name="winterIntervalDays"]').value = chore.winterIntervalDays || '';
  }

  /** Request fields for the chosen frequency; Core clears them for other frequencies. */
  function read(root, cadence) {
    if (cadence !== 'interval') return {};
    const winter = root.querySelector('[name="winterIntervalDays"]').value;
    return { intervalDays: Number(root.querySelector('[name="intervalDays"]').value), winterIntervalDays: winter ? Number(winter) : null };
  }

  window.FamilyFrequency = { labels, label, kidLabel, options, fields, bind, fill, read };
})();
