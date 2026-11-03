import { randomUUID } from 'node:crypto';
import { open, rename, unlink } from 'node:fs/promises';
import path from 'node:path';

export async function privateJson(file, value, { exclusive = false } = {}) {
  const target = exclusive ? file : `${file}.${randomUUID()}.tmp`;
  const handle = await open(target, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); }
  finally { await handle.close(); }
  if (!exclusive) {
    try { await rename(target, file); }
    catch (error) { await unlink(target).catch(() => {}); throw error; }
  }
  if (process.platform !== 'win32') {
    const directory = await open(path.dirname(file), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  }
}
