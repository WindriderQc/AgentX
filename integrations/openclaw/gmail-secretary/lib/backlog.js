import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildOrganizeCommand, buildReadCommand, buildSearchCommand, defaults, evidenceArgs, required, runGog, unwrapExternalText } from "./gmail.js";
import { loadRules, matchRule, reportRuleHit } from "./triage-rules.js";
import { continueReading, readingFrom, writeReading } from "./backlog-reading.js";

// Oldest-first mailbox catch-up, newest-Inbox watch and verified labelling.
export const TRIAGE_CATEGORIES = ["Urgent", "Needs Reply", "Waiting", "Receipts", "Newsletters", "FYI", "Review"];
const ARCHIVE_CATEGORIES = new Set(["Receipts", "Newsletters", "FYI"]);
const BACKLOG_PAGE_CHARS = 20000;
const RULE_TRIAGE_LIMIT = 10;
const RULE_TRIAGE_BUDGET_MS = 120000;
export const ARCHIVE_REVIEW_LABEL = "Secretary/À archiver";
export const MAILBOX_BACKLOG_QUERY = 'in:anywhere -in:spam -in:trash -in:drafts -in:sent -label:"Secretary/Processed"';

function monthStart(value) {
  const match = /^(\d{4})-(\d{2})$/.exec(String(value || ""));
  if (!match) return new Date("2006-12-01T00:00:00Z");
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, 1));
}

function monthKey(value) {
  return `${value.getUTCFullYear()}-${String(value.getUTCMonth() + 1).padStart(2, "0")}`;
}

function nextMonth(value) {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth() + 1, 1));
}

export function backlogQuery(start, end) {
  const after = Math.floor(start.getTime() / 1000) - 1;
  const before = Math.floor(end.getTime() / 1000);
  return `${MAILBOX_BACKLOG_QUERY} after:${after} before:${before}`;
}

async function readTriageState(config) {
  try {
    const value = JSON.parse(await readFile(config.triageStateFile, "utf8"));
    if (value.scope !== "mailbox") return { scope: "mailbox", cursorMonth: "1970-01" };
    return { scope: "mailbox", cursorMonth: monthKey(monthStart(value.cursorMonth)) };
  } catch {
    return { scope: "mailbox", cursorMonth: "1970-01" };
  }
}

async function writeTriageState(config, state) {
  await mkdir(path.dirname(config.triageStateFile), { recursive: true, mode: 0o700 });
  const temp = `${config.triageStateFile}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await rename(temp, config.triageStateFile);
}

export function buildBacklogReadCommand(message, config = defaults) {
  return buildReadCommand({
    kind: "message",
    id: required(message?.id, "message.id"),
    format: "full",
    sanitizeContent: true,
    size: BACKLOG_PAGE_CHARS,
  }, config);
}

export async function findOldestBacklogMessage(config, mode = "oldest", run = runGog) {
  const picked = await selectBacklogMessage(config, mode, run);
  return picked.selected ? inspectBacklogMessage(picked.selected, config, { mode, cursorMonth: picked.cursorMonth }, run) : picked;
}

// Selection reads search metadata only; the body is read after rules are checked.
async function selectBacklogMessage(config, mode, run) {
  const messageRows = response => {
    if (Array.isArray(response)) return response;
    if (response && Object.hasOwn(response, "messages") && (Array.isArray(response.messages) || response.messages === null)) return response.messages || [];
    throw new Error("Gmail search returned an invalid response");
  };
  if (mode === "recent") {
    const response = await run(buildSearchCommand({
      scope: "messages", query: 'in:inbox -in:spam -in:trash -label:"Secretary/Processed"', max: 1,
    }, config), config);
    const matches = messageRows(response);
    if (!Array.isArray(matches)) throw new Error("Gmail recent search returned an invalid response");
    if (!matches.length) return { status: "empty", mode, message: null };
    return { status: "selected", mode, cursorMonth: monthKey(new Date()), selected: matches[0] };
  }
  const state = await readTriageState(config);
  let start = monthStart(state.cursorMonth);
  const lastMonth = nextMonth(new Date());
  const search = async (low, high, max = 1) => {
    const response = await run(buildSearchCommand({ scope: "messages", query: backlogQuery(low, high), max }, config), config);
    const value = messageRows(response);
    if (!Array.isArray(value)) throw new Error("Gmail backlog search returned an invalid response");
    return value;
  };
  // A new mailbox scope starts before the old Inbox cursor. Recheck earlier
  // mail before reporting empty, including messages restored behind the cursor.
  if (!(await search(start, lastMonth)).length) start = new Date(0);
  if (!(await search(start, lastMonth)).length) {
    state.cursorMonth = monthKey(new Date());
    await writeTriageState(config, state);
    return { status: "empty", mode, cursorMonth: state.cursorMonth, message: null };
  }
  let low = start;
  let high = lastMonth;
  while (high.getTime() - low.getTime() > 86400000) {
    const mid = new Date(low.getTime() + Math.floor((high.getTime() - low.getTime()) / 2));
    if ((await search(low, mid)).length) high = mid;
    else low = mid;
  }

  let matches = await search(low, high, 50);
  if (!matches.length) matches = await search(start, lastMonth, 50);
  matches.sort((left, right) => String(left.date || "").localeCompare(String(right.date || "")));
  const selected = matches[0];
  if (!selected) throw new Error(`backlog search became inconsistent in ${state.cursorMonth}`);
  state.cursorMonth = monthKey(low);
  await writeTriageState(config, state);
  return { status: "selected", mode, cursorMonth: state.cursorMonth, selected };
}

async function inspectBacklogMessage(selected, config, context, run) {
    const inspected = await run(buildBacklogReadCommand(selected, config), config);
    return {
      status: "ready",
      ...context,
      message: {
        id: inspected?.id || selected.id,
        threadId: inspected?.threadId || selected.threadId,
        date: inspected?.date || selected.date,
        from: inspected?.from || selected.from,
        subject: unwrapExternalText(inspected?.subject || selected.subject),
        body: typeof inspected?.body === "string" ? inspected.body.slice(0, 20000) : "",
        bodyTruncated: inspected?.bodyTruncated === true || (typeof inspected?.body === "string" && inspected.body.length > 20000),
        sourceHash: inspected?.sourceHash,
        nextOffset: inspected?.nextOffset,
        totalChars: inspected?.totalChars,
        labels: inspected?.labels || selected.labels,
        externalContent: inspected?.externalContent,
      },
    };
}

// Owner rules classify matching senders without the model; the first message
// no rule covers is read and returned. autoTriaged lists what rules handled.
export async function nextBacklogMessage(config, mode = "oldest", run = runGog, deps = {}) {
  const { rules = loadRules, triage = applyTriage, hit = reportRuleHit, onRule = async () => {}, now = Date.now } = deps;
  const ruleSet = await rules(config);
  const autoTriaged = [];
  const seen = new Set();
  const deadline = now() + RULE_TRIAGE_BUDGET_MS;
  for (;;) {
    const picked = await selectBacklogMessage(config, mode, run);
    if (!picked.selected) return { ...picked, autoTriaged };
    const selected = picked.selected;
    const from = unwrapExternalText(selected.from);
    const subject = unwrapExternalText(selected.subject);
    const rule = matchRule(ruleSet, { from, subject });
    if (rule && (seen.has(selected.id) || autoTriaged.length >= RULE_TRIAGE_LIMIT || now() > deadline)) {
      return { status: "ruled", mode, cursorMonth: picked.cursorMonth, message: null, autoTriaged };
    }
    if (!rule) {
      const value = await inspectBacklogMessage(selected, config, { mode, cursorMonth: picked.cursorMonth }, run);
      await writeReading(config, readingFrom(value.message));
      return { ...value, autoTriaged };
    }
    seen.add(selected.id);
    const receipt = await triage({ threadId: selected.threadId, category: rule.category }, config, run);
    const entry = { date: selected.date, from, subject, category: rule.category, ruleId: rule.id,
      archiveCandidate: receipt.archiveCandidate, archived: false };
    autoTriaged.push(entry);
    await onRule({ ...entry, threadId: selected.threadId });
    await hit(config, rule.id);
  }
}

export async function continueBacklogMessage(params, config, run = runGog) {
  const page = await continueReading(config, params, ({ id, offset, sourceHash }) =>
    run(buildReadCommand({ kind: "message", id, offset, sourceHash, size: BACKLOG_PAGE_CHARS }, config), config));
  return { status: "ready", mode: "continue", message: { id: params.id, threadId: page?.threadId,
    body: typeof page?.body === "string" ? page.body : "", bodyTruncated: page?.bodyTruncated === true,
    sourceHash: page?.sourceHash, offset: page?.offset, nextOffset: page?.nextOffset, totalChars: page?.totalChars,
    externalContent: page?.externalContent } };
}

// A re-triage replaces the previous category: only one Secretary category label
// remains. Only labels that exist in the mailbox can be removed.
export function buildTriageCommands(params, config = defaults, existingLabels = []) {
  const threadId = required(params.threadId, "threadId");
  const category = required(params.category, "category");
  if (!TRIAGE_CATEGORIES.includes(category)) throw new Error(`unsupported triage category: ${category}`);
  const label = `Secretary/${category}`;
  const archiveCandidate = ARCHIVE_CATEGORIES.has(category);
  const labels = [label, "Secretary/Processed", ...(archiveCandidate ? [ARCHIVE_REVIEW_LABEL] : [])];
  const existing = new Set(existingLabels);
  const removeLabels = [
    ...TRIAGE_CATEGORIES.map(name => `Secretary/${name}`).filter(name => name !== label && existing.has(name)),
    ...(!archiveCandidate ? [ARCHIVE_REVIEW_LABEL] : []),
  ];
  const commands = [buildOrganizeCommand({
    action: "label_threads",
    ids: [threadId],
    addLabels: labels,
    ...(removeLabels.length ? { removeLabels } : {}),
  }, config)];
  return { category, label, labels, removeLabels, archiveCandidate, archived: false, commands };
}

async function labelIdsByName(run, config) {
  const labels = await run(buildReadCommand({ kind: "labels" }, config), config);
  const labelRows = Array.isArray(labels) ? labels : (labels.labels || []);
  return new Map(labelRows.map((entry) => [unwrapExternalText(entry.name), entry.id]));
}

export async function applyTriage(params, config, run = runGog) {
  const plan = buildTriageCommands(params, config, [...(await labelIdsByName(run, config)).keys()]);
  const stateCommand = { program: "python3", timeoutMs: 125000,
    args: [...evidenceArgs("thread_state", config), params.threadId] };
  const before = await run(stateCommand, config);
  const beforeMessages = before?.thread?.messages;
  if (!Array.isArray(beforeMessages) || !beforeMessages.length) throw new Error("Gmail thread state is unavailable before triage");
  const stateBefore = new Map(beforeMessages.map(message => [message.id, {
    inbox: message.labelIds?.includes("INBOX") === true,
    unread: message.labelIds?.includes("UNREAD") === true,
  }]));
  const results = [];
  for (const command of plan.commands) results.push(await run(command, config));
  const labelIds = await labelIdsByName(run, config);
  const thread = await run(stateCommand, config);
  const wanted = plan.labels.map(label => labelIds.get(label));
  const removed = plan.removeLabels.filter(label => label !== ARCHIVE_REVIEW_LABEL).map(label => labelIds.get(label)).filter(Boolean);
  const messages = thread?.thread?.messages || [];
  const allLabelsPresent = wanted.every(Boolean) && messages.length > 0
    && messages.every((message) => wanted.every((id) => message.labelIds?.includes(id)))
    && messages.every((message) => !removed.some((id) => message.labelIds?.includes(id)));
  const stateUnchanged = [...stateBefore].every(([id, before]) => {
    const message = messages.find(message => message.id === id);
    return message && (message.labelIds?.includes("INBOX") === true) === before.inbox
      && (message.labelIds?.includes("UNREAD") === true) === before.unread;
  });
  const candidateRemoved = plan.archiveCandidate || messages.every(message => !message.labelIds?.includes(labelIds.get(ARCHIVE_REVIEW_LABEL)));
  if (!allLabelsPresent || !stateUnchanged || !candidateRemoved) {
    throw new Error("Gmail triage verification failed");
  }
  return {
    ok: true,
    threadId: params.threadId,
    category: plan.category,
    labels: plan.labels,
    archiveCandidate: plan.archiveCandidate,
    archived: plan.archived,
    commands: results.length,
  };
}
