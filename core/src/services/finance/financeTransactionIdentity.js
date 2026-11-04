'use strict';

const keyOf = row => [row.accountKey, row.date, row.fingerprint, row.occurrence].join('|');
function selector(key) {
  const parts = String(key).split('|');
  const occurrence = Number(parts.pop());
  const fingerprint = parts.pop();
  const date = parts.pop();
  return { accountKey: parts.join('|'), date, fingerprint, occurrence };
}
module.exports = { keyOf, selector };
