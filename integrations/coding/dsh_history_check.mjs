/** Read retained DSH histories through their native, reviewed reader. No agent is created. */
import { parseArgs } from 'node:util';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readdir, realpath } from 'node:fs/promises';

const { values } = parseArgs({ options: {
  'runtime-root': { type: 'string' }, 'studio-sessions': { type: 'string' },
  'workers-root': { type: 'string' },
} });
if (!values['runtime-root'] || !values['studio-sessions'] || !values['workers-root']) {
  throw new Error('Explicit runtime, Studio session root and worker root are required');
}
const runtime = await realpath(values['runtime-root']);
const moduleAt = async name => import(pathToFileURL(join(runtime, 'node_modules', name, 'lib/index.js')).href);
const { Context } = await moduleAt('@deepseek-ai/cordis');
const persistence = await moduleAt('@deepseek-ai/dsh-session-persistence-jsonl');
const roots = [{ kind: 'studio', root: await realpath(values['studio-sessions']) }];
const workersRoot = await realpath(values['workers-root']);
for (const entry of await readdir(workersRoot, { withFileTypes: true })) {
  if (!entry.isDirectory() || !/^\.home-task-\d{4,12}$/u.test(entry.name)) continue;
  const path = join(workersRoot, entry.name, '.dsh/progress-sessions');
  const root = await realpath(path).catch(error => {
    if (error.code !== 'ENOENT') throw error;
  });
  if (!root) continue;
  if (!root.startsWith(resolve(workersRoot) + '/')) throw new Error('Worker history escapes its configured root');
  roots.push({ kind: 'worker', root });
}
const summary = { schema: 'agentx.dsh-native-history-check/v1', liveModelCalls: 0,
  roots: roots.length, studioSessions: 0, workerSessions: 0, events: 0, readFailures: 0, errors: [] };
const failure = (source, error) => {
  summary.readFailures++;
  // This diagnostic is a private receipt, never a transcript export.
  summary.errors.push({ kind: source.kind, error: String(error.message ?? error).slice(0, 500) });
};
for (const source of roots) {
  const ctx = new Context();
  try {
    await ctx.plugin(persistence.default ?? persistence,
      { root: source.root, compression: source.kind === 'studio' ? 'zstd' : 'none' }).await();
    for (const stored of await ctx.sessionPersistence.list()) {
      try {
        const handle = await ctx.sessionPersistence.open(stored.header.id, 'read');
        try {
          const { events } = await handle.read();
          if (!Array.isArray(events)) throw new Error('Invalid native history');
          summary[source.kind === 'studio' ? 'studioSessions' : 'workerSessions']++;
          summary.events += events.length;
        } finally { await handle.close(); }
      } catch (error) { failure(source, error); }
    }
  } catch (error) { failure(source, error); }
  finally { await ctx.fiber.dispose(); }
}
console.log(JSON.stringify(summary));
process.exitCode = summary.readFailures ? 1 : 0;
