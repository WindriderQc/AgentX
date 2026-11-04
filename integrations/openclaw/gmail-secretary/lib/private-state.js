import { randomUUID } from 'node:crypto';
import { mkdir, open, rename, unlink } from 'node:fs/promises';
import path from 'node:path';

async function syncDirectory(directory) {
  if (process.platform === 'win32') return;
  const handle = await open(directory, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

export async function privateDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (process.platform === 'win32') return;
  // A new receipt namespace must survive with its parent entries, including
  // concurrent mkdir callers. Sync the ancestry before any external dispatch.
  let current = path.resolve(directory);
  for (;;) {
    await syncDirectory(current);
    const parent = path.dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

export async function privateJson(file, value, { exclusive = false } = {}) {
  const target = exclusive ? file : `${file}.${randomUUID()}.tmp`;
  const handle = await open(target, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); }
  finally { await handle.close(); }
  if (!exclusive) {
    try { await rename(target, file); }
    catch (error) { await unlink(target).catch(() => {}); throw error; }
  }
  await syncDirectory(path.dirname(file));
}
