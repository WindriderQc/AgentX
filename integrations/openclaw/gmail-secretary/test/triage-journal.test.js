import test from "node:test";
import assert from "node:assert/strict";
import { journalTriage, triageTag } from "../lib/triage-journal.js";

const config = { coreUrl: "http://core.invalid/" };
const entry = { threadId: "t1", category: "Needs Reply", occurredAt: "2026-03-10T14:00:00Z", summary: "A synthetic sender asks for a signed form by Friday.",
  subject: "Synthetic subject", counterpart: "Synthetic sender" };
const reply = (status, data) => ({ ok: status < 300, status, json: async () => (status < 300 ? { status: "success", data } : { message: "refused" }) });

test("a triaged thread without a digest gets one, tagged with its category", async () => {
  const sent = [];
  const fetchImpl = async (url, init) => { const body = JSON.parse(init.body); sent.push([url, body]);
    return reply(200, body.action === "search" ? { ok: true, entries: [] } : { ok: true, recorded: true }); };
  assert.deepEqual(await journalTriage(config, entry, fetchImpl), { recorded: true });
  assert.equal(sent[0][0], "http://core.invalid/api/consumers/nestor/v1/mail-journal");
  assert.deepEqual(sent[0][1], { action: "search", threadId: "t1", limit: 1 });
  assert.deepEqual(sent[1][1], { action: "record", threadId: "t1", occurredAt: "2026-03-10T14:00:00Z", summary: entry.summary,
    subject: "Synthetic subject", counterpart: "Synthetic sender", tags: ["triage", "needs-reply"] });
  assert.equal(triageTag("Newsletters"), "newsletters");
});

test("the Secretary's own digest is kept, and a journal failure never throws", async () => {
  const kept = await journalTriage(config, entry, async () => reply(200, { ok: true, entries: [{ threadId: "t1" }] }));
  assert.deepEqual(kept, { recorded: false, reason: "already journaled" });
  const down = await journalTriage(config, entry, async () => reply(503, null));
  assert.deepEqual(down, { recorded: false, reason: "refused" });
  const offline = await journalTriage(config, entry, async () => { throw new Error("connect ECONNREFUSED"); });
  assert.deepEqual(offline, { recorded: false, reason: "connect ECONNREFUSED" });
  const old = await journalTriage(config, entry, async (_url, init) => reply(200, JSON.parse(init.body).action === "search"
    ? { ok: true, entries: [] } : { ok: true, recorded: false, reason: "older than the journal retention" }));
  assert.deepEqual(old, { recorded: false, reason: "older than the journal retention" });
});
