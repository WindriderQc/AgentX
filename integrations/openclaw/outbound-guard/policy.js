// Outbound message policy (ADR 0003, rule 3; #206).
//
// The native `message` tool reaches people. A send, edit, delete, poll or any
// other channel action toward a destination that is not one of the owner's
// own conversations needs the owner's approval, enforced here instead of by
// prompt guidance. Reads, replies in the current conversation (no explicit
// target) and deliveries to the owner's configured conversations pass.
import { isBackgroundAction } from '../../../shared/agentActionProvenance.cjs';

const READ_ONLY = new Set([
  "read", "reactions", "pins", "permissions", "search", "member-info", "member info", "role-info", "role info",
  "channel-info", "channel info", "channel-list", "channel list", "thread-list", "thread list", "emoji-list",
  "emoji list", "voice-status", "voice status", "event-list", "event list",
]);

const normalize = value => String(value ?? "").trim().toLowerCase();

/** "telegram:-100123:topic:330" -> { channel: "telegram", target: "-100123:topic:330" } */
function splitTarget(channel, target) {
  const raw = normalize(target);
  const prefixed = /^([a-z]+):(.+)$/.exec(raw);
  if (!normalize(channel) && prefixed && !/^(channel|user|chat_id|chat_guid|chat_identifier|group|uuid|username|u|conversation|spaces|users)$/.test(prefixed[1])) {
    return { channel: prefixed[1], target: prefixed[2] };
  }
  return { channel: normalize(channel), target: raw };
}

/** An owner conversation entry also covers its forum topics and threads. */
export function isOwnerTarget(ownerTargets, channel, target) {
  const wanted = splitTarget(channel, target);
  return (ownerTargets || []).some(entry => {
    const owned = splitTarget("", entry);
    if (owned.channel && wanted.channel && owned.channel !== wanted.channel) return false;
    return wanted.target === owned.target || wanted.target.startsWith(`${owned.target}:`);
  });
}

/** The approval the owner must give for this message tool call, or null when it may run. */
export function outboundApproval(params = {}, { ownerTargets = [] } = {}) {
  const action = normalize(params.action) || "send";
  if (READ_ONLY.has(action)) return null;
  const target = params.target ?? params.to;
  if (target === undefined || target === null || String(target).trim() === "") return null;
  if (isOwnerTarget(ownerTargets, params.channel, target)) return null;
  const destination = `${params.channel ? `${params.channel}:` : ""}${target}`;
  const text = typeof params.message === "string" ? ` — ${params.message.replace(/\s+/g, " ").slice(0, 120)}` : "";
  return {
    title: "Message outside the household",
    description: `${action} to ${destination}${text}`.slice(0, 256),
    severity: ["delete", "kick", "ban", "timeout", "broadcast"].includes(action) ? "critical" : "warning",
  };
}

export function outboundDecision(params = {}, { ownerTargets = [], provenance } = {}) {
  const action = normalize(params.action) || 'send';
  if (READ_ONLY.has(action)) return null;
  const target = params.target ?? params.to;
  if (isBackgroundAction(provenance)) {
    // An owner-configured report destination remains available. It does not
    // authorize edits/deletions there or contacts requested by ingested text.
    if (action === 'send' && target && splitTarget(params.channel, target).channel
        && isOwnerTarget(ownerTargets, params.channel, target)) return null;
    return { block: true, blockReason: `ADR 0003: ${provenance.origin} sessions cannot perform this messaging action; ask the owner in a conversation.` };
  }
  let approval = outboundApproval(params, { ownerTargets });
  if (!approval && !target && provenance?.origin !== 'owner_turn') {
    approval = { title: 'Confirm messaging destination', description: 'The runtime does not establish an owner conversation for this action.', severity: 'warning' };
  }
  return approval ? { requireApproval: { ...approval,
    description: `${approval.description} [origin: ${provenance?.origin || 'unknown'}]`.slice(0, 256),
    allowedDecisions: ['allow-once', 'deny'], timeoutMs: 300000, timeoutBehavior: 'deny',
  } } : null;
}
