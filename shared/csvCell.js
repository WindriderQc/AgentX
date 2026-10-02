'use strict';

/**
 * One CSV cell, safe to open in a spreadsheet: the rule every AgentX CSV
 * export uses.
 *
 * Text a spreadsheet would run as a formula (= + - @ after optional leading
 * whitespace, or a leading tab, CR or LF) gets an apostrophe prefix. A string
 * that is only a number (`-12.50`, `-149,41`) stays as written, so amounts
 * remain numbers. A cell holding the separator, a quote, CR or LF is quoted,
 * with quotes doubled.
 *
 * Browsers receive this same function as `/js/csv-cell.js` (an ES module
 * exporting `csvCell`) or `/js/csv-cell.global.js` (sets
 * `window.AgentXCsvCell` for classic scripts). It must stay self-contained:
 * its source text is what those files serve.
 */
function csvCell(value, separator = ',') {
  if (value === null || value === undefined) return '';
  let text = String(value);
  const numeric = /^-?\d+(?:[.,]\d+)?$/.test(text);
  if (typeof value === 'string' && !numeric && (/^\s*[=+\-@]/.test(text) || /^[\t\r\n]/.test(text))) {
    text = `'${text}`;
  }
  return text.includes(separator) || /["\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

const HEADER = '// Generated from shared/csvCell.js; do not edit.\n';

function browserModuleSource() {
  return `${HEADER}export ${csvCell.toString()}\n`;
}

function browserGlobalSource() {
  return `${HEADER}window.AgentXCsvCell = (function () {\n${csvCell.toString()}\nreturn csvCell;\n})();\n`;
}

/** Serve both browser forms from an Express app. */
function mountBrowserCsvCell(app) {
  app.get('/js/csv-cell.js', (_req, res) => {
    res.type('application/javascript').send(browserModuleSource());
  });
  app.get('/js/csv-cell.global.js', (_req, res) => {
    res.type('application/javascript').send(browserGlobalSource());
  });
}

module.exports = { csvCell, browserModuleSource, browserGlobalSource, mountBrowserCsvCell };
