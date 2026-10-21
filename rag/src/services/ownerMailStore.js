'use strict';

const { RagStore } = require('./ragStore');

// The owner's private recall corpus (mail bodies, read attachments, souvenirs
// and people): its own Qdrant collection, never the shared knowledge one, so
// no shared search, listing, cleanup or snapshot route can reach it.
function collectionName(env = process.env) {
  const name = env.QDRANT_OWNER_MAIL_COLLECTION || 'agentx_owner_mail';
  if (name === (env.QDRANT_COLLECTION || 'agentx_embeddings')) {
    throw Object.assign(new Error('The owner recall corpus needs its own collection'), { statusCode: 503, code: 'OWNER_MAIL_RECALL_UNCONFIGURED' });
  }
  return name;
}

let store = null;
function getOwnerMailStore() {
  if (!store) store = new RagStore({ collectionName: collectionName() });
  return store;
}
function resetOwnerMailStore() { store = null; }

module.exports = { getOwnerMailStore, resetOwnerMailStore, collectionName };
