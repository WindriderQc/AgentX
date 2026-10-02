import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  ARCHIVE_REVIEW_LABEL,
  MAILBOX_BACKLOG_QUERY,
  applyTriage,
  backlogQuery,
  findOldestBacklogMessage,
  approvalFor,
  buildBacklogReadCommand,
  buildDraftCommand,
  buildOrganizeCommand,
  buildReadCommand,
  buildSearchCommand,
  buildSendCommand,
  buildTriageCommands,
  unwrapExternalText,
  evidenceCommand,
} from "../lib/tools.js";

test("evidence uses the fixed helper and JSON stdin, never a shell or model-supplied path", () => {
  const instance = { evidenceHelperPath: "/srv/agentx/helper.py", evidenceRoot: "/private/evidence" };
  assert.deepEqual(evidenceCommand({ action: "next", evidenceHelperPath: "/untrusted.py" }, instance).args,
    [instance.evidenceHelperPath, "--root", instance.evidenceRoot, "native_next"]);
  const review = { pageId: "hash", summary: "$(do not execute)", actions: [] };
  assert.equal(evidenceCommand({ action: "record", review }).stdin, JSON.stringify(review));
  assert.throws(() => evidenceCommand({ action: "exec" }));
  assert.throws(() => evidenceCommand({ action: "record" }));
});

const config = {
  account: "auto",
  timezone: "America/Toronto",
  attachmentRoot: process.cwd(),
};

test("read search is read-only, send-blocked, exact, and wrapped", () => {
  const { args } = buildSearchCommand({ scope: "messages", query: "is:unread", max: 5 }, config);
  assert.ok(args.includes("--readonly"));
  assert.ok(args.includes("--gmail-no-send"));
  assert.ok(args.includes("--wrap-untrusted"));
  assert.ok(args.includes("--enable-commands-exact=gmail.messages.search"));
});

test("every thread body uses the bounded reader even when full is requested", () => {
  const command = buildReadCommand({
    kind: "thread",
    id: "thread-1",
    full: true,
  }, config);
  assert.equal(command.program, "python3");
  assert.ok(command.args.includes("read_source"));
  assert.equal(JSON.parse(command.stdin).size, 10000);
});

test("oldest-first backlog reads only the selected message body", () => {
  const command = buildBacklogReadCommand({ id: "message-1" }, config);
  assert.ok(command.args.includes("read_source"));
  assert.equal(JSON.parse(command.stdin).kind, "message");
  assert.equal(JSON.parse(command.stdin).id, "message-1");
});

test("metadata search retains its continuation token and never bulk reads bodies", () => {
  const { args } = buildSearchCommand({ query: "in:anywhere", includeBody: true, pageToken: "next-page" }, config);
  assert.ok(!args.includes("--include-body"));
  assert.ok(!args.includes("--results-only"));
  assert.ok(args.includes("--page=next-page"));
});

test("triage preserves the reader's incomplete flag even for a short returned page", async () => {
  const result = await findOldestBacklogMessage(config, "recent", async ({ args }) => args.includes("search")
    ? { messages: [{ id: "message1", threadId: "thread01" }] }
    : { body: "First page", bodyTruncated: true, nextOffset: 10000, sourceHash: "source" });
  assert.equal(result.message.bodyTruncated, true);
  assert.equal(result.message.nextOffset, 10000);
});

test("query-based organization stays bounded and requires approval", () => {
  const { args } = buildOrganizeCommand({ action: "archive", query: "older_than:1y", max: 12 }, config);
  assert.ok(args.includes("--max=12"));
  assert.ok(args.includes("--gmail-no-send"));
  assert.equal(approvalFor("gmail_secretary_organize", { action: "archive", query: "older_than:1y" }).severity, "warning");
});

test("label actions validate only fields used by the selected action", () => {
  const create = buildOrganizeCommand({ action: "create_label", label: "Secretary/Urgent" }, config);
  assert.ok(create.args.includes("--enable-commands-exact=gmail.labels.create"));
  assert.ok(create.args.includes("Secretary/Urgent"));

  const modify = buildOrganizeCommand({
    action: "label_threads",
    ids: ["thread-1"],
    addLabels: ["Secretary/Urgent"],
  }, config);
  assert.ok(modify.args.includes("--enable-commands-exact=gmail.labels.modify"));
  assert.ok(modify.args.includes("--add=Secretary/Urgent"));
});

test("draft creation cannot send", async () => {
  const { args, stdin } = await buildDraftCommand({ action: "create", to: ["person@example.com"], subject: "Hello", body: "Draft only" }, config);
  assert.ok(args.includes("--gmail-no-send"));
  assert.ok(args.includes("--enable-commands-exact=gmail.drafts.create"));
  assert.equal(stdin, "Draft only");
});

test("send uses the exact send command and always requires approval", async () => {
  const { args, stdin } = await buildSendCommand({ action: "new", to: ["person@example.com"], subject: "Hello", body: "World" }, config);
  assert.ok(args.includes("--enable-commands-exact=gmail.send"));
  assert.ok(!args.includes("--gmail-no-send"));
  assert.equal(stdin, "World");
  assert.equal(approvalFor("gmail_secretary_send", { action: "new", to: ["person@example.com"] }).title, "Send Gmail message");
});

test("permanent draft deletion requires critical approval", () => {
  const approval = approvalFor("gmail_secretary_draft", { action: "delete", id: "draft-1" });
  assert.equal(approval.severity, "critical");
});

test("every scheduled category labels only; archive candidates await owner review", () => {
  for (const category of ["Urgent", "Needs Reply", "Waiting", "Review", "FYI", "Receipts", "Newsletters"]) {
    const plan = buildTriageCommands({ threadId: "thread-1", category }, config);
    assert.equal(plan.archived, false);
    assert.equal(plan.commands.length, 1);
    assert.ok(plan.commands[0].args.includes("--enable-commands-exact=gmail.labels.modify"));
    const candidate = ["FYI", "Receipts", "Newsletters"].includes(category);
    assert.equal(plan.archiveCandidate, candidate);
    assert.equal(plan.labels.includes(ARCHIVE_REVIEW_LABEL), candidate);
    assert.ok(plan.commands[0].args.includes("thread-1"));
    assert.ok(!plan.commands.flatMap(entry => entry.args).some(arg => /^(archive|trash|send|mark-read|unread)$/.test(arg)));
  }
});

test("explicit archive and removing Inbox require existing native owner approval", () => {
  assert.ok(approvalFor("gmail_secretary_organize", { action: "archive", ids: ["thread-1"] }));
  assert.ok(approvalFor("gmail_secretary_organize", { action: "label_threads", ids: ["thread-1"], removeLabels: ["INBOX"] }));
});

function triageMailbox({ loseInbox = false, loseUnread = false, omitCandidate = false } = {}) {
  const labels = [{ name: "Secretary/Receipts", id: "receipt" }, { name: "Secretary/Processed", id: "processed" }, { name: ARCHIVE_REVIEW_LABEL, id: "candidate" }];
  const messages = [{ id: "inbox", labelIds: ["INBOX", "UNREAD"] }, { id: "archived", labelIds: ["UNREAD"] }];
  return { messages, run: async ({ args }) => {
    if (args.includes("--enable-commands-exact=gmail.labels.list")) return labels;
    if (args.includes("thread_state")) return { thread: { messages: structuredClone(messages) } };
    assert.ok(args.includes("--enable-commands-exact=gmail.labels.modify"));
    for (const message of messages) {
      message.labelIds.push("receipt", "processed", ...(!omitCandidate ? ["candidate"] : []));
      if (loseInbox) message.labelIds = message.labelIds.filter(label => label !== "INBOX");
      if (loseUnread) message.labelIds = message.labelIds.filter(label => label !== "UNREAD");
    }
    return { ok: true };
  } };
}

test("archive proposal preserves mixed Inbox and unread state in the same thread", async () => {
  const mailbox = triageMailbox();
  const receipt = await applyTriage({ threadId: "t1", category: "Receipts" }, config, mailbox.run);
  assert.equal(receipt.ok, true);
  assert.equal(receipt.archived, false);
  assert.equal(receipt.archiveCandidate, true);
  assert.ok(mailbox.messages[0].labelIds.includes("INBOX"));
  assert.ok(!mailbox.messages[1].labelIds.includes("INBOX"));
  assert.ok(mailbox.messages.every(message => message.labelIds.includes("UNREAD")));
});

test("triage refuses success if Inbox/read state changed or the proposal label is missing", async () => {
  for (const options of [{ loseInbox: true }, { loseUnread: true }, { omitCandidate: true }]) {
    await assert.rejects(applyTriage({ threadId: "t1", category: "Receipts" }, config, triageMailbox(options).run), /verification failed/);
  }
});

test("archaeology searches archived received mail and excludes sent, drafts, Spam and Trash", () => {
  const query = backlogQuery(new Date(0), new Date("2026-10-01"));
  assert.ok(query.startsWith(MAILBOX_BACKLOG_QUERY));
  assert.ok(query.includes("in:anywhere"));
  assert.ok(!query.includes("in:inbox"));
  for (const excluded of ["sent", "drafts", "spam", "trash"]) assert.ok(query.includes(`-in:${excluded}`));
});

test("newest Inbox watch is independent of the historical cursor", async () => {
  const calls = [];
  const result = await findOldestBacklogMessage(config, "recent", async ({ args }) => {
    calls.push(args);
    if (args.includes("search")) return [{ id: "new", threadId: "new-thread", subject: "New message" }];
    return { body: "Current message" };
  });
  assert.equal(result.message.id, "new");
  assert.ok(calls[0].some(arg => arg.startsWith("in:inbox ")));
  assert.equal(calls.length, 2);
});

test("legacy Inbox cursor cannot skip old archives; empty month does not mean empty mailbox", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "secretary-test-"));
  try {
    const triageStateFile = path.join(dir, "cursor.json");
    await writeFile(triageStateFile, JSON.stringify({ cursorMonth: "2026-09" }));
    const date = new Date("2008-06-05T12:00:00Z");
    const queries = [];
    const result = await findOldestBacklogMessage({ ...config, triageStateFile }, "oldest", async ({ args }) => {
      if (!args.includes("search")) return { body: "Old archived receipt" };
      const query = args[args.indexOf("search") + 1];
      queries.push(query);
      const after = Number(query.match(/after:(-?\d+)/)[1]) * 1000;
      const before = Number(query.match(/before:(\d+)/)[1]) * 1000;
      return date > after && date < before ? [{ id: "old", threadId: "old-thread", date: "2008-06-05 12:00" }] : [];
    });
    assert.equal(result.message.id, "old");
    assert.ok(queries[0].includes("after:-1"));
    assert.equal(JSON.parse(await readFile(triageStateFile, "utf8")).scope, "mailbox");
  } finally { await rm(dir, { recursive: true }); }
});

test("wrapped Gmail label names can be verified without exposing wrapper syntax", () => {
  const wrapped = '<<<EXTERNAL_UNTRUSTED_CONTENT id="example">>>\nSource: google_api\n---\nSecretary/Processed\n<<<END_EXTERNAL_UNTRUSTED_CONTENT id="example">>>';
  assert.equal(unwrapExternalText(wrapped), "Secretary/Processed");
});
