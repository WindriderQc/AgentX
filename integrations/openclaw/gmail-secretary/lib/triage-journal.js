// Every triaged thread leaves a dated digest in the owner's mail journal (AgentX
// Core), so the main agent can read what happened in the mail without opening
// the mailbox. The journal entry is written here, with the triage, and not
// left to a later step of the model: a classified mail without its digest was
// invisible to everyone but the Secretary.
//
// A digest the Secretary already recorded for the thread is kept: hers is the
// fuller one. A journal that cannot be reached never undoes a verified triage;
// the receipt says the digest is missing.
const JOURNAL_PATH = "/api/consumers/nestor/v1/mail-journal";

export const triageTag = category => String(category || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

export async function journalTriage(config, entry, fetchImpl = globalThis.fetch) {
  const url = `${String(config.coreUrl || "").replace(/\/$/, "")}${JOURNAL_PATH}`;
  const post = async payload => {
    const response = await fetchImpl(url, { method: "POST", redirect: "error", signal: AbortSignal.timeout(8000),
      headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
    const body = await response.json().catch(() => null);
    if (!response.ok || body?.status !== "success" || body.data?.ok !== true) {
      throw new Error(String(body?.message || `mail journal unavailable (${response.status})`).slice(0, 200));
    }
    return body.data;
  };
  try {
    const existing = await post({ action: "search", threadId: entry.threadId, limit: 1 });
    if (Array.isArray(existing.entries) && existing.entries.length) return { recorded: false, reason: "already journaled" };
    const saved = await post({ action: "record", threadId: entry.threadId, occurredAt: entry.occurredAt, summary: entry.summary,
      ...(entry.subject && { subject: entry.subject }), ...(entry.counterpart && { counterpart: entry.counterpart }),
      tags: ["triage", triageTag(entry.category)].filter(Boolean) });
    return saved.recorded === true ? { recorded: true } : { recorded: false, reason: String(saved.reason || "not recorded").slice(0, 200) };
  } catch (error) {
    return { recorded: false, reason: String(error?.message || "mail journal unavailable").slice(0, 200) };
  }
}
