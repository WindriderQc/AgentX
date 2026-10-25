/**
 * Two-line element (TLE) text helpers: parse a three-line listing, check a
 * line's modulo-10 checksum, and read the element set's epoch.
 */

// Three-line TLE text → [{ name, noradId, tle1, tle2 }].
function parseTleText(text) {
  const lines = String(text || '').split(/\r?\n/).map(l => l.replace(/\s+$/, '')).filter(Boolean);
  const out = [];
  for (let i = 0; i + 2 < lines.length + 1; i += 3) {
    const name = lines[i];
    const l1 = lines[i + 1];
    const l2 = lines[i + 2];
    if (!l1 || !l2 || !l1.startsWith('1 ') || !l2.startsWith('2 ')) continue;
    const noradId = l1.slice(2, 7).trim();
    out.push({ name: (name || '').trim(), noradId, tle1: l1, tle2: l2 });
  }
  return out;
}

// Column 69 is the sum of the digits of columns 1–68, minus signs counting 1, modulo 10.
function checksumOk(line) {
  if (typeof line !== 'string' || line.length < 69) return false;
  let sum = 0;
  for (const ch of line.slice(0, 68)) {
    if (ch >= '0' && ch <= '9') sum += Number(ch);
    else if (ch === '-') sum += 1;
  }
  return sum % 10 === Number(line[68]);
}

// Epoch from line 1, columns 19–32: two-digit year (57–99 → 19xx) and fractional day of year.
function epochOf(line1) {
  const yy = Number(String(line1 || '').slice(18, 20));
  const day = Number(String(line1 || '').slice(20, 32));
  if (!Number.isFinite(yy) || !Number.isFinite(day) || day < 1 || day >= 367) return null;
  const year = yy < 57 ? 2000 + yy : 1900 + yy;
  return new Date(Date.UTC(year, 0, 1) + (day - 1) * 86_400_000);
}

function isValidElementSet(set) {
  return !!set && checksumOk(set.tle1) && checksumOk(set.tle2)
    && set.tle1.slice(2, 7) === set.tle2.slice(2, 7) && epochOf(set.tle1) !== null;
}

module.exports = { parseTleText, checksumOk, epochOf, isValidElementSet };
