/** Read native attachment references without creating an agent or rewriting a session. */
import { createHash } from 'node:crypto';

export function attachmentReferences(events) {
  const pending = [events];
  const references = [];
  while (pending.length) {
    const value = pending.pop();
    if (!value || typeof value !== 'object') continue;
    if (Array.isArray(value)) { pending.push(...value); continue; }
    if (Object.hasOwn(value, 'attachment')) {
      const ref = value.attachment;
      if (!['image', 'file'].includes(value.type) || !ref || typeof ref !== 'object') {
        throw new Error('Unsupported native attachment reference');
      }
      references.push({ kind: value.type, ref });
    }
    pending.push(...Object.values(value));
  }
  return references;
}

export async function verifyAttachment(store, { kind, ref }) {
  if (!/^sha256:[a-f0-9]{64}$/u.test(ref.attachmentId || '') || !Number.isSafeInteger(ref.bytes) || ref.bytes < 0) {
    throw new Error('Invalid native attachment identity');
  }
  const hash = createHash('sha256');
  let bytes = 0;
  if (kind === 'image') {
    // Native reading verifies normalized bytes, digest, dimensions and media type.
    const result = await store.readImage(ref);
    hash.update(result.data);
    bytes = result.data.byteLength;
  } else if (kind === 'file') {
    // Exhaust the native stream: integrity failures may arrive after its last chunk.
    for await (const chunk of store.readFileStream(ref)) { hash.update(chunk); bytes += chunk.byteLength; }
  } else throw new Error('Unsupported native attachment kind');
  const sha256 = hash.digest('hex');
  if (bytes !== ref.bytes || `sha256:${sha256}` !== ref.attachmentId) throw new Error('Native attachment integrity mismatch');
  return { kind, bytes, sha256 };
}
