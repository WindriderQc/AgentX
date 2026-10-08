'use strict';

const fs = require('fs/promises');

// Optional read-only instance mount. The file is never copied into Product.
const QUEUE_FILE = '/instance/config/QUEUE.md';

function displayCell(value, limit) {
  const plain = value.replace(/\*\*|`/g, '').replace(/\s+/g, ' ').trim();
  return plain.length <= limit ? plain : `${plain.slice(0, limit - 1).trimEnd()}…`;
}

function parseHeavyQueue(markdown) {
  const sections = { Running: [], Waiting: [] };
  let section = null;
  for (const line of String(markdown || '').split(/\r?\n/)) {
    const heading = line.match(/^## (Running|Waiting|Done)\s*$/);
    if (heading) {
      section = heading[1] in sections ? heading[1] : null;
      continue;
    }
    if (!section || !/^\|.*\|\s*$/.test(line)) continue;
    const cells = line.slice(1, line.lastIndexOf('|')).split('|').map(cell => cell.trim());
    if (cells.length < 6 || !/^\d+$/.test(cells[0])) continue;
    sections[section].push({
      priority: Number(cells[0]),
      job: displayCell(cells[1], 240),
      hosts: displayCell(cells[3], 160),
      estimated: displayCell(cells[4], 240),
      timing: displayCell(cells[5], 160)
    });
  }
  return { running: sections.Running, waiting: sections.Waiting };
}

async function getHeavyQueue(file = QUEUE_FILE) {
  try {
    const [markdown, stat] = await Promise.all([fs.readFile(file, 'utf8'), fs.stat(file)]);
    return {
      available: true,
      ...parseHeavyQueue(markdown),
      modifiedAt: stat.mtime.toISOString(),
      observedAt: new Date().toISOString(),
      authority: 'instance.QUEUE.md',
      scope: 'advisory-heavy-work-queue'
    };
  } catch (error) {
    if (error.code !== 'ENOENT' && error.code !== 'EACCES') throw error;
    return { available: false, running: [], waiting: [], reason: 'Instance heavy queue is not mounted.' };
  }
}

module.exports = { getHeavyQueue, parseHeavyQueue };
