import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildTriageCommands, nextBacklogMessage, continueBacklogMessage } from "../lib/tools.js";
import { matchRule, senderAddress, loadRules, resetRulesCache } from "../lib/triage-rules.js";
import { assertFullyRead, readReading } from "../lib/backlog-reading.js";

const rules = [
  { id: "r1", from: "@example-ci.test", category: "FYI" },
  { id: "r2", from: "alerts@example-ci.test", category: "Review" },
  { id: "r3", from: "example-ci.test", subjectContains: "Invoice", category: "Receipts" },
  { id: "r4", from: "@shop.test", category: "Urgent" },
  { id: "r5", from: "@quiet.test", category: "Newsletters", enabled: false },
];

test("sender address is taken from the display form", () => {
  assert.equal(senderAddress('"CI Bot" <Bot@Example-CI.test>'), "bot@example-ci.test");
  assert.equal(senderAddress("plain@site.test"), "plain@site.test");
  assert.equal(senderAddress("No address"), "");
});

test("the most specific enabled rule wins and action categories are never automatic", () => {
  assert.equal(matchRule(rules, { from: "Bot <bot@example-ci.test>", subject: "Run failed" }).id, "r1");
  assert.equal(matchRule(rules, { from: "bot@mail.example-ci.test", subject: "x" }).id, "r1");
  assert.equal(matchRule(rules, { from: "alerts@example-ci.test", subject: "x" }).id, "r2");
  assert.equal(matchRule(rules, { from: "alerts@example-ci.test", subject: "Your invoice #3" }).id, "r3");
  assert.equal(matchRule(rules, { from: "a@notexample-ci.test", subject: "x" }), null);
  assert.equal(matchRule(rules, { from: "a@shop.test", subject: "x" }), null);
  assert.equal(matchRule(rules, { from: "a@quiet.test", subject: "x" }), null);
});

test("an unreachable Core means no rules, never a failed triage", async () => {
  resetRulesCache();
  const value = await loadRules({ coreUrl: "http://core.test" }, async () => { throw new Error("offline"); });
  assert.deepEqual(value, []);
  resetRulesCache();
  const loaded = await loadRules({ coreUrl: "http://core.test" }, async (url) => {
    assert.equal(url, "http://core.test/api/secretary/triage-rules?enabled=true");
    return { ok: true, json: async () => ({ data: { rules } }) };
  });
  assert.equal(loaded.length, rules.length);
  resetRulesCache();
});

test("re-triage replaces the previous Secretary category that exists in the mailbox", () => {
  const plan = buildTriageCommands({ threadId: "t1", category: "FYI" }, {},
    ["Secretary/Review", "Secretary/Newsletters", "Secretary/FYI", "Secretary/Processed"]);
  assert.deepEqual(plan.removeLabels, ["Secretary/Newsletters", "Secretary/Review"]);
  const args = plan.commands[0].args;
  assert.ok(args.includes("--remove=Secretary/Newsletters,Secretary/Review"));
  const review = buildTriageCommands({ threadId: "t1", category: "Review" }, {}, ["Secretary/FYI"]);
  assert.deepEqual(review.removeLabels, ["Secretary/FYI", "Secretary/À archiver"]);
});

async function withState(run) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "secretary-rules-"));
  try { return await run({ account: "auto", triageStateFile: path.join(dir, "cursor.json") }); }
  finally { await rm(dir, { recursive: true }); }
}

test("rule-matched mail is labelled without the model; the next message is read in full", () => withState(async (config) => {
  const inbox = [
    { id: "m1", threadId: "t1", from: "CI <bot@example-ci.test>", subject: "Run failed" },
    { id: "m2", threadId: "t2", from: "Friend <friend@home.test>", subject: "Dinner?" },
  ];
  const triaged = [];
  const hits = [];
  const value = await nextBacklogMessage(config, "recent", async ({ args }) => {
    if (args.includes("search")) return { messages: inbox.slice(triaged.length, triaged.length + 1) };
    return { id: "m2", threadId: "t2", body: "Page one", bodyTruncated: true, nextOffset: 20000, totalChars: 30000, sourceHash: "a".repeat(64) };
  }, {
    rules: async () => rules,
    triage: async (params) => { triaged.push(params); return { ok: true, archiveCandidate: true }; },
    hit: async (_config, id) => { hits.push(id); },
  });
  assert.deepEqual(triaged, [{ threadId: "t1", category: "FYI" }]);
  assert.deepEqual(hits, ["r1"]);
  assert.equal(value.autoTriaged.length, 1);
  assert.equal(value.message.id, "m2");
  await assert.rejects(assertFullyRead(config, "t2"), /not fully read/);
  await assertFullyRead(config, "other-thread");

  await assert.rejects(continueBacklogMessage({ id: "m2", sourceHash: "a".repeat(64), offset: 10 }, config, async () => ({})), /cannot be skipped/);
  const page = await continueBacklogMessage({ id: "m2", sourceHash: "a".repeat(64), offset: 20000 }, config, async ({ stdin }) => {
    assert.equal(JSON.parse(stdin).offset, 20000);
    return { threadId: "t2", body: "Page two", bodyTruncated: false, nextOffset: null, totalChars: 30000, sourceHash: "a".repeat(64), offset: 20000 };
  });
  assert.equal(page.message.body, "Page two");
  assert.equal((await readReading(config)).complete, true);
  await assertFullyRead(config, "t2");
}));

test("a rule match repeated by a lagging search stops instead of looping", () => withState(async (config) => {
  let triages = 0;
  const value = await nextBacklogMessage(config, "recent", async () => ({ messages: [{ id: "m1", threadId: "t1", from: "bot@example-ci.test", subject: "x" }] }), {
    rules: async () => rules,
    triage: async () => { triages += 1; return { ok: true }; },
    hit: async () => {},
  });
  assert.equal(triages, 1);
  assert.equal(value.status, "ruled");
  assert.equal(value.message, null);
}));
