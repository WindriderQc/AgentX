import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { assertFullyRead, readReading, readSelectedMessage } from "../lib/backlog-reading.js";

const hash = "a".repeat(64);
const first = { id: "message-1", threadId: "thread-1", sourceHash: hash, body: "First page",
  bodyTruncated: true, nextOffset: 10, totalChars: 20, offset: 0 };
async function state(run) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "message-reading-"));
  try { return await run({ triageStateFile: path.join(dir, "cursor.json") }); }
  finally { await rm(dir, { recursive: true }); }
}

test("a missing reading receipt or another message/thread cannot authorize classification", () => state(async config => {
  await assert.rejects(assertFullyRead(config, "thread-1", "message-1"), /Read the selected message/);
  await readSelectedMessage(config, { id: "message-1" }, async () => ({ ...first, bodyTruncated: false, nextOffset: null }));
  assert.equal((await assertFullyRead(config, "thread-1", "message-1")).messageId, "message-1");
  await assert.rejects(assertFullyRead(config, "thread-1", "message-2"), /Read the selected message/);
  await assert.rejects(assertFullyRead(config, "thread-2", "message-1"), /Read the selected message/);
}));

test("direct message reading shares the sequential backlog guard; an arbitrary last page cannot skip the body", () => state(async config => {
  await assert.rejects(readSelectedMessage(config, { id: "message-1", sourceHash: hash, offset: 10 }, async () => first), /continue must name/);
  await readSelectedMessage(config, { id: "message-1" }, async () => first);
  await assert.rejects(assertFullyRead(config, "thread-1", "message-1"), /not fully read/);
  await assert.rejects(readSelectedMessage(config, { id: "message-1", sourceHash: hash, offset: 15 }, async () => first), /cannot be skipped/);
  await readSelectedMessage(config, { id: "message-1", sourceHash: hash, offset: 10 }, async () => ({
    ...first, body: "Final page", offset: 10, bodyTruncated: false, nextOffset: null
  }));
  assert.equal((await assertFullyRead(config, "thread-1", "message-1")).complete, true);
}));

test("a changed source, thread, page or total cannot advance the saved reading receipt", () => state(async config => {
  await readSelectedMessage(config, { id: "message-1" }, async () => first);
  for (const change of [{ sourceHash: "b".repeat(64) }, { threadId: "thread-2" }, { offset: 0 }, { totalChars: 30 }]) {
    await assert.rejects(readSelectedMessage(config, { id: "message-1", sourceHash: hash, offset: 10 }, async () => ({
      ...first, offset: 10, bodyTruncated: false, nextOffset: null, ...change
    })), /did not confirm/);
    assert.equal((await readReading(config)).readTo, 10);
    assert.equal((await readReading(config)).complete, false);
  }
}));

test("unidentified or unbounded initial reads do not create a classification receipt", () => state(async config => {
  for (const change of [{ id: "message-2" }, { sourceHash: "" }, { bodyTruncated: undefined }, { totalChars: null }]) {
    await assert.rejects(readSelectedMessage(config, { id: "message-1" }, async () => ({ ...first, ...change })), /did not confirm/);
    assert.equal(await readReading(config), null);
  }
}));
