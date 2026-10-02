import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

// Actions hide in long mail. The message the triage selected must be read to
// its last page before a category is applied; this file remembers how far.
export function readingStateFile(config) {
  return config.readingStateFile || path.join(path.dirname(config.triageStateFile), "gmail-triage-reading.json");
}

export async function readReading(config) {
  try {
    const value = JSON.parse(await readFile(readingStateFile(config), "utf8"));
    return value && typeof value.threadId === "string" ? value : null;
  } catch {
    return null;
  }
}

export async function writeReading(config, value) {
  const file = readingStateFile(config);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  await rename(temp, file);
}

export function readingFrom(message) {
  const totalChars = Number.isInteger(message?.totalChars) ? message.totalChars : null;
  const readTo = Number.isInteger(message?.nextOffset) ? message.nextOffset : totalChars;
  return { threadId: message.threadId, messageId: message.id, sourceHash: message.sourceHash,
    totalChars, readTo, complete: message.bodyTruncated !== true };
}

export async function assertFullyRead(config, threadId) {
  const reading = await readReading(config);
  if (!reading || reading.threadId !== threadId || reading.complete) return;
  throw new Error(`Message not fully read: call gmail_secretary_backlog_next with continue {"id":"${reading.messageId}","sourceHash":"${reading.sourceHash}","offset":${reading.readTo}} until bodyTruncated is false, then classify.`);
}

export async function continueReading(config, params, readPage) {
  const reading = await readReading(config);
  if (!reading || reading.messageId !== params.id || reading.sourceHash !== params.sourceHash) {
    throw new Error("continue must name the message the triage selected, with its sourceHash");
  }
  if (params.offset !== reading.readTo) throw new Error(`continue from offset ${reading.readTo}; pages cannot be skipped`);
  const page = await readPage({ id: params.id, offset: params.offset, sourceHash: params.sourceHash });
  const next = readingFrom({ ...page, threadId: reading.threadId, id: reading.messageId });
  await writeReading(config, next);
  return page;
}
