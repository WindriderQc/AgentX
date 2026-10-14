import { copyFile, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createClientPlugin, normalizePipelineUrl } from '../src/client.mjs';

const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
const repositoryRoot = resolve(sourceRoot, '../../..');

export function pipelineUrlForCore(value) {
  if (typeof value !== 'string' || value.trim() !== value || /[\u0000-\u0020]/u.test(value)) {
    throw new TypeError('Core URL must be an HTTPS origin');
  }
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.search
      || url.hash || url.pathname !== '/') {
    throw new TypeError('Core URL must be an HTTPS origin without credentials, path, query or fragment');
  }
  return normalizePipelineUrl(new URL('/pipeline#pipelineWorkerMonitor', url).href);
}

/** Build only into a new external directory: generated links are instance configuration. */
export async function buildPackage({ coreUrl, output }) {
  const pipelineUrl = pipelineUrlForCore(coreUrl);
  if (!isAbsolute(output || '')) throw new TypeError('Output must be an absolute external directory');
  // Resolve the parent, including symlinks, before creating an output directory.
  const parent = await realpath(dirname(output));
  const destination = resolve(parent, relative(dirname(output), output));
  const fromRepository = relative(await realpath(repositoryRoot), destination);
  if (fromRepository !== '..' && !fromRepository.startsWith(`..${sep}`) && !isAbsolute(fromRepository)) {
    throw new TypeError('Generated packages must stay outside the AgentX repository');
  }
  const manifest = JSON.parse(await readFile(resolve(sourceRoot, 'package.json'), 'utf8'));
  delete manifest.scripts;
  await mkdir(destination, { mode: 0o700 });
  await mkdir(resolve(destination, 'lib'), { mode: 0o700 });
  const bundle = `window.__ModuleLoader__.load({
  id: ${JSON.stringify(manifest.name)},
  factory(require) {
    ${normalizePipelineUrl.toString()}
    ${createClientPlugin.toString()}
    return createClientPlugin(require('react'), ${JSON.stringify(pipelineUrl)});
  },
});
`;
  await writeFile(resolve(destination, 'lib/client.js'), bundle, { mode: 0o600 });
  await copyFile(resolve(sourceRoot, 'src/index.mjs'), resolve(destination, 'lib/index.js'));
  await writeFile(resolve(destination, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  for (const file of ['cordis.patch.yml', 'README.md']) {
    await copyFile(resolve(sourceRoot, file), resolve(destination, file));
  }
  await copyFile(resolve(repositoryRoot, 'LICENSE'), resolve(destination, 'LICENSE'));
  return destination;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const options = {};
    const args = process.argv.slice(2);
    for (let i = 0; i < args.length; i += 2) {
      const name = args[i];
      const value = args[i + 1];
      if (!['--core-url', '--output'].includes(name) || !value || value.startsWith('--')) {
        throw new TypeError('Usage: node scripts/package.mjs --core-url https://agentx.example --output /private/new-package');
      }
      if (Object.hasOwn(options, name)) throw new TypeError(`Repeated option ${name}`);
      options[name] = value;
    }
    console.log(await buildPackage({ coreUrl: options['--core-url'], output: options['--output'] }));
  } catch (error) {
    // Do not echo URLs; invalid input may contain credentials.
    console.error(error instanceof TypeError ? error.message : 'Package creation failed');
    process.exitCode = 1;
  }
}
