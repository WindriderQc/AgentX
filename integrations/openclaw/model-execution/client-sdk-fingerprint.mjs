import { createHash } from 'node:crypto';
import { readFile, readdir, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { isAbsolute, join, relative, sep } from 'node:path';

const inside = (base, path) => {
  const rel = relative(base, path);
  return !isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep);
};
const refuse = () => { throw new Error('OPENCLAW_CLIENT_DEPENDENCY_TOPOLOGY_UNQUALIFIED'); };

// The Google digest already binds SDK/AI executable code. Extend it with the
// actual provider client and its installed runtime/peer dependency graph. Read
// immutable package code only; no auth store, instance config or environment.
export async function clientSdkFingerprint(root, sdkFingerprint, client) {
  if (!sdkFingerprint) return null;
  root = await realpath(root);
  const modules = join(root, 'node_modules'), packages = new Map(), missing = new Set();
  async function locate(context, name, specifier = name) {
    const require = createRequire(join(context, 'qualification-resolution.cjs'));
    let selected;
    // Bind resolution to the nearest actual package directory. A shadow whose
    // main export links to the original package must not hide changed subpaths.
    for (const path of require.resolve.paths(name) || []) {
      if (!inside(modules, join(path, name))) continue;
      try {
        const directory = await realpath(join(path, name));
        if (!inside(modules, directory)) refuse();
        const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
        if (manifest.name !== name) refuse();
        selected = { directory, manifest }; break;
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    let entry;
    try { entry = await realpath(require.resolve(specifier)); }
    catch (error) { if (selected) refuse(); throw error; }
    if (!selected || !inside(modules, entry) || !inside(selected.directory, entry)) refuse();
    return selected;
  }
  async function visitPackage(pkg) {
    if (packages.has(pkg.directory)) return;
    packages.set(pkg.directory, pkg);
    const dependencies = new Set(Object.keys(pkg.manifest.dependencies || {}));
    const peers = Object.keys(pkg.manifest.peerDependencies || {});
    for (const name of [...new Set([...dependencies, ...peers])].sort()) {
      try { await visitPackage(await locate(pkg.directory, name)); }
      catch (error) {
        if (error.code !== 'MODULE_NOT_FOUND' || dependencies.has(name)) throw error;
        missing.add(JSON.stringify([relative(root, pkg.directory).split(sep).join('/'), name]));
      }
    }
  }
  const clientPackage = await locate(join(root, 'dist'), client);
  const entries = client === '@mistralai/mistralai' ? [client, `${client}/lib/http`, `${client}/sdk/chat`] : [client];
  for (const context of [await realpath(join(root, 'dist')), await realpath(join(modules, '@openclaw/ai/dist'))]) {
    for (const entry of entries) if ((await locate(context, client, entry)).directory !== clientPackage.directory) refuse();
  }
  await visitPackage(clientPackage);
  const digest = createHash('sha256').update(JSON.stringify(['agentx.native-client-code/v1', sdkFingerprint, client]));
  for (const [base] of [...packages].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    const files = [];
    async function visit(directory) {
      for (const entry of (await readdir(join(base, directory), { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
        const path = directory ? `${directory}/${entry.name}` : entry.name;
        if (entry.isSymbolicLink()) refuse();
        if (entry.isDirectory()) {
          if (entry.name === 'node_modules') { if (directory) refuse(); else continue; }
          if (['src', 'test', 'tests', 'examples', 'docs'].includes(entry.name) || entry.name.startsWith('.')) continue;
          await visit(path);
        } else if (entry.isFile() && /\.(?:[cm]?js|json)$/.test(entry.name)) files.push(path);
      }
    }
    await visit('');
    for (const file of files) digest.update(JSON.stringify([relative(root, base).split(sep).join('/'), file,
      createHash('sha256').update(await readFile(join(base, file))).digest('hex')]) + '\n');
  }
  for (const name of [...missing].sort()) digest.update(name + '\n');
  return digest.digest('hex');
}
