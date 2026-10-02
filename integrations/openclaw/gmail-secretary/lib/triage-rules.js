// Owner-editable sender rules. Core owns them (Super Dad desk); this plugin
// only reads them over loopback and applies a match without the model.
// Action categories stay with the model: they need an email-action card.
export const RULE_CATEGORIES = Object.freeze(["Receipts", "Newsletters", "FYI", "Review"]);
const RULES_TTL_MS = 60000;

let cache = { url: "", at: 0, rules: [] };

export function senderAddress(from) {
  const value = String(from || "").trim().toLowerCase();
  const bracket = value.match(/<([^<>\s]+@[^<>\s]+)>/);
  if (bracket) return bracket[1];
  const bare = value.match(/[^\s<>"',;]+@[^\s<>"',;]+/);
  return bare ? bare[0] : "";
}

function senderMatches(pattern, address) {
  const wanted = String(pattern || "").trim().toLowerCase();
  if (!wanted || !address) return false;
  if (wanted.includes("@") && !wanted.startsWith("@")) return address === wanted;
  const domain = wanted.replace(/^@/, "");
  const actual = address.slice(address.lastIndexOf("@") + 1);
  return actual === domain || actual.endsWith(`.${domain}`);
}

// The most specific rule wins: subject-qualified, then exact address, then domain.
function specificity(rule) {
  return (rule.subjectContains ? 4 : 0) + (String(rule.from).includes("@") && !String(rule.from).startsWith("@") ? 2 : 0);
}

export function matchRule(rules, { from, subject } = {}) {
  const address = senderAddress(from);
  const title = String(subject || "").toLowerCase();
  const matches = (Array.isArray(rules) ? rules : []).filter(rule => rule && rule.enabled !== false
    && RULE_CATEGORIES.includes(rule.category)
    && senderMatches(rule.from, address)
    && (!rule.subjectContains || title.includes(String(rule.subjectContains).toLowerCase())));
  return matches.sort((left, right) => specificity(right) - specificity(left))[0] || null;
}

// A missing Core never blocks triage: the model simply classifies everything.
export async function loadRules(config, fetchImpl = globalThis.fetch) {
  const url = `${String(config.coreUrl || "").replace(/\/$/, "")}/api/secretary/triage-rules?enabled=true`;
  if (cache.url === url && Date.now() - cache.at < RULES_TTL_MS) return cache.rules;
  try {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(3000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.json();
    const rules = body?.data?.rules;
    if (!Array.isArray(rules)) throw new Error("invalid rules response");
    cache = { url, at: Date.now(), rules };
    return rules;
  } catch {
    return cache.url === url ? cache.rules : [];
  }
}

export async function reportRuleHit(config, ruleId, fetchImpl = globalThis.fetch) {
  const base = String(config.coreUrl || "").replace(/\/$/, "");
  try {
    await fetchImpl(`${base}/api/secretary/triage-rules/${encodeURIComponent(ruleId)}/hit`,
      { method: "POST", signal: AbortSignal.timeout(3000) });
  } catch { /* A hit counter never fails a verified triage. */ }
}

export function resetRulesCache() { cache = { url: "", at: 0, rules: [] }; }
