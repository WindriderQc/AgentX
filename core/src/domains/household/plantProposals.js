'use strict';

// A child's plant proposal (#876): the rules, independent of storage.
// A child sends one photo and, optionally, the room the plant lives in; there is
// no other text. The proposal becomes a draft card marked with the child's
// profile. It waits for a parent: only a parent opens, completes and publishes
// it, or declines it with a short reply the child reads. One proposal per child
// waits at a time.

const { FamilyInputError } = require('./family');

// The rooms a child can pick on the tablet (the parent page offers the same names).
const PROPOSAL_ROOMS = Object.freeze(['Salon', 'Cuisine', 'Chambre', 'Salle de bain', 'Bureau', 'Sous-sol']);
// pending: sent, not seen yet; opened: a parent opened it (identification may run);
// accepted: the parent published it; declined: the parent answered no.
const PROPOSAL_STATES = Object.freeze(['pending', 'opened', 'accepted', 'declined']);
const OPEN_STATES = Object.freeze(['pending', 'opened']);
const DEFAULT_REPLY = 'Papa a vu ta plante. Merci !';
const REPLY_MAX = 160;

const fail = (message, code = 'PLANT_PROPOSAL_INVALID') => new FamilyInputError(message, code);

/** The child's input: a profile, a photo and an optional room from the list. Nothing else. */
function proposalInput(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw fail('A proposal is an object');
  const unknown = Object.keys(input).filter(key => !['profileId', 'room', 'dataUrl'].includes(key));
  if (unknown.length) throw fail(`A proposal takes only a photo and a room (${unknown.join(', ')})`);
  const profileId = String(input.profileId ?? '').trim();
  if (!profileId) throw fail('Choose who you are first', 'PLANT_PROPOSAL_PROFILE_REQUIRED');
  const room = input.room === undefined || input.room === null || input.room === '' ? null : String(input.room);
  if (room !== null && !PROPOSAL_ROOMS.includes(room)) throw fail(`room must be one of ${PROPOSAL_ROOMS.join(', ')}`);
  if (typeof input.dataUrl !== 'string' || !input.dataUrl) throw fail('A proposal needs a photo', 'PLANT_PHOTO_INVALID');
  return { profileId, room, dataUrl: input.dataUrl };
}

/** The parent's reply when declining: short, one line, a friendly default. */
function replyInput(value) {
  const reply = String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, REPLY_MAX);
  return reply || DEFAULT_REPLY;
}

/** The draft's nickname until the parent names the plant. */
const proposalNickname = displayName => `Plante de ${String(displayName || 'un enfant').trim()}`.slice(0, 60);

const isOpen = proposal => Boolean(proposal) && OPEN_STATES.includes(proposal.state);

/** Fields that close an open proposal, for one atomic card write. */
function closing(state, at, reply = null) {
  return {
    set: { 'proposal.state': state, 'proposal.decidedAt': at, ...(state === 'declined' ? { 'proposal.reply': replyInput(reply) } : {}) },
    unset: { 'proposal.open': '' }
  };
}

/** What the parent sees about a proposal on the card. */
function proposalView(proposal) {
  if (!proposal?.proposedBy) return null;
  return {
    proposedBy: proposal.proposedBy,
    state: PROPOSAL_STATES.includes(proposal.state) ? proposal.state : 'pending',
    open: isOpen(proposal),
    proposedAt: proposal.proposedAt || null,
    openedAt: proposal.openedAt || null,
    decidedAt: proposal.decidedAt || null,
    reply: proposal.reply || null
  };
}

/**
 * What the child sees about their own proposal: its state, the room, the
 * parent's reply when declined, and the plant's name once it is in Ma jungle.
 * Never species candidates, care drafts or review state.
 */
function childProposal(plant = {}) {
  const proposal = plant.proposal || {};
  const id = String(plant._id || plant.id);
  const state = PROPOSAL_STATES.includes(proposal.state) ? proposal.state : 'pending';
  return {
    id,
    state,
    room: plant.room || null,
    proposedAt: proposal.proposedAt || null,
    decidedAt: proposal.decidedAt || null,
    reply: state === 'declined' ? proposal.reply || DEFAULT_REPLY : null,
    plant: state === 'accepted' && plant.status === 'published' ? { id, nickname: plant.nickname } : null,
    photoUrl: plant.photos?.length ? `/api/family/plant-proposals/${encodeURIComponent(id)}/photo?profileId=${encodeURIComponent(proposal.proposedBy)}` : null
  };
}

module.exports = {
  DEFAULT_REPLY,
  OPEN_STATES,
  PROPOSAL_ROOMS,
  PROPOSAL_STATES,
  REPLY_MAX,
  childProposal,
  closing,
  isOpen,
  proposalInput,
  proposalNickname,
  proposalView,
  replyInput
};
