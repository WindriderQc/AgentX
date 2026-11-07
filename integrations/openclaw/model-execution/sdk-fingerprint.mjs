import { createHash } from 'node:crypto';
import { readFile, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { createRequire } from 'node:module';

// Pin the executable SDK distribution and both native Google transport packages.
// Version strings alone do not identify patched dependencies. Ignore source maps,
// declarations and assets; never read runtime configuration or credential stores.
export async function googleSdkFingerprint(root) {
  const ai = join(root, 'node_modules/@openclaw/ai');
  const google = join(root, 'node_modules/@google/genai');
  const refuseTopology = () => { throw new Error('OPENCLAW_GOOGLE_DEPENDENCY_TOPOLOGY_UNQUALIFIED'); };
  // Node resolves imports from the importing module, not the SDK root. Refuse
  // shadow packages before admitting the shared dependency layout we tested.
  for (const context of [root, ai]) {
    const directory = await realpath(join(context, 'dist'));
    const require = createRequire(join(directory, 'qualification-resolution.cjs'));
    for (const [specifier, expected] of [['@openclaw/ai', ai], ['@google/genai', google], ['@google/genai/node', google]]) {
      const resolved = await realpath(require.resolve(specifier));
      const path = relative(await realpath(join(expected, 'dist')), resolved);
      if (isAbsolute(path) || path === '..' || path.startsWith('..' + sep)) refuseTopology();
    }
  }
  const digest = createHash('sha256');
  for (const relative of ['', 'node_modules/@openclaw/ai', 'node_modules/@google/genai']) {
    const base = join(root, relative);
    const files = ['package.json'];
    async function visit(directory) {
      for (const entry of (await readdir(join(base, directory), { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
        const path = `${directory}/${entry.name}`;
        // An unvisited symlink could shadow resolution deeper in dist without
        // changing any hashed file, including under bundled provider extensions.
        if (entry.isSymbolicLink()) refuseTopology();
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
