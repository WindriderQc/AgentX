import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

// Pin the executable SDK distribution and both native Google transport packages.
// Version strings alone do not identify patched dependencies. Ignore source maps,
// declarations and assets; never read runtime configuration or credential stores.
export async function googleSdkFingerprint(root) {
  const digest = createHash('sha256');
  for (const relative of ['', 'node_modules/@openclaw/ai', 'node_modules/@google/genai']) {
    const base = join(root, relative);
    const files = ['package.json'];
    async function visit(directory) {
      for (const entry of (await readdir(join(base, directory), { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
        const path = `${directory}/${entry.name}`;
        if (entry.isDirectory()) await visit(path);
        else if (entry.isFile() && /\.(?:[cm]?js|json)$/.test(entry.name)) files.push(path);
      }
    }
    await visit('dist');
    for (const file of files) {
      const hash = createHash('sha256').update(await readFile(join(base, file))).digest('hex');
      digest.update(JSON.stringify([relative, file, hash]) + '\n');
    }
  }
  return digest.digest('hex');
}
