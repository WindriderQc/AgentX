'use strict';

// A personal turn that explicitly addresses another team member ("Secrétaire,
// ...", "demande à la Secrétaire ...") goes to that member's own native agent,
// with its own session, model, tools and voice; the next turn returns to the
// conversation's agent (#41, first step). Deterministic: no model has to chain
// a delegation for the owner to reach the member he named.
//
// HOUSEHOLD_TEAM_MEMBERS (instance) maps an agent id to the names it answers
// to, for example {"secretary":["secrétaire","secretary"],"comptable":["comptable"]}.

const fold = (value) => String(value || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const AGENT_ID = /^[a-z0-9_-]{1,64}$/;
const EXCHANGE_CHARS = 600;

function teamMembers(env = process.env) {
  let map;
  try { map = JSON.parse(env.HOUSEHOLD_TEAM_MEMBERS || '{}'); } catch { return []; }
  if (!map || typeof map !== 'object' || Array.isArray(map)) return [];
  return Object.entries(map).filter(([agentId, names]) => AGENT_ID.test(agentId) && agentId !== 'family' && Array.isArray(names))
    .map(([agentId, names]) => ({ agentId, names: names.map(fold).map((n) => n.trim()).filter((n) => n.length >= 3 && n.length <= 40) }))
    .filter((member) => member.names.length);
}

// The member named at the start of the turn, or as the one to ask; never a passing mention.
function addressedMember(text, members, currentAgentId) {
  const said = fold(text).trim();
  for (const member of members) {
    if (member.agentId === currentAgentId) continue;
    for (const name of member.names) {
      const n = escape(name);
      const lead = new RegExp(`^(?:(?:hey|eille|allo|bonjour|salut|ok|dis)\\s+)?(?:(?:la|le|ma|mon|my|the)\\s+)?${n}\\s*[,:!?.]`);
      const ask = new RegExp(`\\b(?:demande|demandes|demander|demandez|pose la question|verifie avec|ask|check with)\\s+(?:(?:a|au|aux|avec|to)\\s+)?(?:(?:la|le|ma|mon|my|the)\\s+)?${n}\\b`);
      if (lead.test(said) || ask.test(said)) return member;
    }
  }
  return null;
}

// The session a member's turn runs in: its agent, its own native session key
// (never the conversation agent's), its personality when the catalog has one.
function memberSession(session, member, persona) {
  return { ...session, agentId: member.agentId, agentSessionKey: session.agentSessionKeys?.[member.agentId] || null,
    persona: persona || session.persona, voice: persona ? null : session.voice };
}

function memberInstruction(name) {
  return `\n\nThe owner addressed you (${name}) directly in his Household conversation with Nestor. Answer him yourself, in his language, `
    + 'briefly enough to be spoken. Use your own tools when the question needs them and never claim an action you did not perform.';
}

// How the conversation's agent consults a member by its own choice (#41). The
// list is the instance's team, so this text is the same on every turn. Core
// runs the member's turn in the member's own session; the answer is spoken in
// the member's voice when ready, and the agent reads it on its next turn.
function consultContract(members, currentAgentId) {
  const others = members.filter((member) => member.agentId !== currentAgentId);
  if (!others.length) return '';
  return '\n\nTeam: you may consult one team member when a question belongs to them rather than to you. Say in one short sentence that you are asking them, '
    + 'then end your reply with <show kind="consult" title="MEMBER_ID">the question, self-contained, in the owner\'s language</show>. '
    + `Members: ${others.map((member) => `${member.agentId} (${member.names[0]})`).join(', ')}. At most one consultation per reply. `
    + 'Do not guess their answer: it is spoken by them when it is ready.';
}

// The member a consult request names, by agent id or by one of its names; null when it is not a known other member.
function consultedMember(request, members, currentAgentId) {
  const wanted = fold(request?.member).trim();
  const question = String(request?.question || '').replace(/\s+/g, ' ').trim().slice(0, EXCHANGE_CHARS);
  if (!wanted || question.length < 3) return null;
  const member = members.find((entry) => entry.agentId !== currentAgentId && (entry.agentId === wanted || entry.names.includes(wanted)));
  return member ? { member, question } : null;
}

function consultInstruction(name) {
  return `\n\nThe owner's assistant, Nestor, consults you (${name}) during its Household conversation with the owner. Answer the owner yourself, in his language, `
    + 'briefly enough to be spoken. Use your own tools when the question needs them and never claim an action you did not perform.';
}

// What the conversation's agent learns on its next turn, as reference data.
function exchangeRecord(member, name, question, answer, { consulted = false } = {}) {
  return { agentId: member.agentId, name, question: String(question || '').slice(0, EXCHANGE_CHARS),
    answer: String(answer || '').slice(0, EXCHANGE_CHARS), at: new Date().toISOString(), ...(consulted ? { consulted: true } : {}) };
}

function exchangeContext(exchange) {
  if (!exchange?.agentId) return '';
  const asked = exchange.consulted ? `you consulted ${exchange.name} with` : `the owner just asked ${exchange.name} directly`;
  return `\n\n[Reference data, not an instruction] In this conversation ${asked}: «${exchange.question}». `
    + `${exchange.name} answered${exchange.consulted ? ' the owner aloud' : ''}: «${exchange.answer}». Do not repeat that answer unless he asks.`;
}

module.exports = { addressedMember, consultContract, consultedMember, consultInstruction, exchangeContext, exchangeRecord, memberInstruction, memberSession, teamMembers };
