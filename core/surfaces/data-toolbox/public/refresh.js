'use strict';

// One mechanism for a part of a tab that reads itself again. Loaded before the
// tab scripts and app.js, whose `state`, `content`, `e` and `shellRead` it uses
// when called. A refresher gives:
//   - a timer tied to one tab: it starts when the tab is drawn and stops at its
//     first tick on another tab;
//   - nothing asked while the page is hidden, and one read when it shows again;
//   - an answer dropped when the tab or the render changed while it was read;
//   - on request (`holds`), no read while a field of the tab has the focus, a
//     details panel is open or the tab says something unsaved is on screen;
//   - a line saying when the part was last read, and what went wrong if the
//     last automatic read failed. The header (app.js) is told the same.
// The tab keeps what it reads and how it paints it: `read()` asks, `apply()`
// writes the answer into the page in place and may return why it is not good.

const REFRESH_FIELDS = Object.freeze(['INPUT', 'TEXTAREA', 'SELECT']);
const refreshers = [];

const refreshClock = (value) => new Date(value).toLocaleTimeString();
const refreshEvery = (ms) => (ms >= 60000 && ms % 60000 === 0 ? `${ms / 60000} min` : `${Math.round(ms / 1000)} s`);

/** Why an automatic read has to wait, or '' when nothing on the tab is being edited or read closely. */
function refreshHold(extra) {
  const active = document.activeElement;
  const isField = active && (REFRESH_FIELDS.includes(String(active.tagName || '').toUpperCase()) || active.isContentEditable === true);
  if (isField && (typeof content.contains !== 'function' || content.contains(active))) return 'a field on this tab has the focus';
  if (typeof content.querySelector === 'function' && content.querySelector('details[open]')) return 'a details panel is open on this tab';
  return (typeof extra === 'function' && extra()) || '';
}

/** Repaints with `paint()` and puts the scroll offsets of the framed blocks matching `selector` back. */
function refreshKeepScroll(selector, paint) {
  const offsets = typeof document.querySelectorAll === 'function'
    ? [...document.querySelectorAll(selector)].map((frame) => [frame.scrollLeft, frame.scrollTop]) : [];
  paint();
  if (!offsets.length) return;
  [...document.querySelectorAll(selector)].forEach((frame, index) => {
    if (!offsets[index]) return;
    [frame.scrollLeft, frame.scrollTop] = offsets[index];
  });
}

/**
 * @param {object} options
 * @param {string} options.tab       the tab this refresher belongs to
 * @param {number} options.everyMs   the cadence
 * @param {string} [options.stamp]   id of the element that carries the "last read" line
 * @param {boolean} [options.holds]  wait while the tab is being edited (see refreshHold)
 * @param {() => string} [options.blocked]  the tab's own reason to wait
 * @param {() => boolean} [options.ready]   false until the tab has drawn itself
 * @param {() => Promise<any>} options.read
 * @param {(answer: any) => (string|{problem?: string, warning?: string}|void)} options.apply
 */
function tabRefresher(options) {
  const refresher = {
    tab: options.tab, everyMs: options.everyMs, timer: null, busy: false,
    readAt: null, failedAt: null, error: '', held: '',

    /** The tab has just drawn itself from a successful read: stamp it and start the timer. */
    opened() {
      Object.assign(refresher, { readAt: Date.now(), failedAt: null, error: '', held: '' });
      refresher.paintStamp();
      if (!refresher.timer) refresher.timer = setInterval(refresher.tick, refresher.everyMs);
    },

    stop() {
      if (refresher.timer) clearInterval(refresher.timer);
      refresher.timer = null;
    },

    async tick() {
      if (state.tab !== refresher.tab) return refresher.stop();
      if ((options.ready && !options.ready()) || refresher.busy || document.hidden === true) return undefined;
      if (refresher.hold()) return undefined;
      const seq = state.renderSeq;
      const stale = () => seq !== state.renderSeq || state.tab !== refresher.tab;
      refresher.busy = true;
      try {
        let answer;
        let problem = '';
        try { answer = await options.read(); } catch (error) { problem = error?.message || String(error); }
        // A tab change or a newer render made the answer stale: it is dropped.
        if (stale()) return undefined;
        // Something was opened or typed while Data answered: the page is left alone.
        if (refresher.hold()) return undefined;
        let warning = '';
        if (!problem) {
          const outcome = options.apply(answer);
          problem = typeof outcome === 'string' ? outcome : outcome?.problem || '';
          warning = (typeof outcome === 'object' && outcome?.warning) || '';
        }
        if (problem) Object.assign(refresher, { failedAt: Date.now(), error: problem });
        else Object.assign(refresher, { readAt: Date.now(), failedAt: null, error: '' });
        refresher.paintStamp();
        if (typeof shellRead === 'function') shellRead(problem, warning);
      } finally { refresher.busy = false; }
      return undefined;
    },

    /** Reads why the refresh must wait and shows it; '' when it may run. */
    hold() {
      const held = options.holds ? refreshHold(options.blocked) : '';
      if (held !== refresher.held) {
        refresher.held = held;
        refresher.paintStamp();
      }
      return held;
    },

    stampText() {
      const every = refreshEvery(refresher.everyMs);
      const read = refresher.readAt ? refreshClock(refresher.readAt) : 'not yet';
      if (refresher.error) return `Automatic read failed at ${refreshClock(refresher.failedAt)}: ${refresher.error}. Still showing what was read at ${read}; tried again every ${every}.`;
      if (refresher.held) return `Read at ${read}. Automatic refresh (every ${every}) is waiting because ${refresher.held}; Refresh reads now.`;
      return `Read at ${read}. Refreshes itself every ${every} while this tab is open and visible.`;
    },

    stampState: () => (refresher.error ? 'failed' : refresher.held ? 'held' : 'ok'),

    stampHtml() {
      return `<p class="refresh-stamp" id="${e(options.stamp)}" data-state="${refresher.stampState()}">${e(refresher.stampText())}</p>`;
    },

    paintStamp() {
      const target = options.stamp && state.tab === refresher.tab ? document.querySelector(`#${options.stamp}`) : null;
      if (!target) return;
      target.textContent = refresher.stampText();
      if (typeof target.setAttribute === 'function') target.setAttribute('data-state', refresher.stampState());
    }
  };
  refreshers.push(refresher);
  return refresher;
}

// A page that shows again reads at once what a running refresher follows.
document.addEventListener('visibilitychange', () => {
  for (const refresher of refreshers) if (refresher.timer) refresher.tick();
});
