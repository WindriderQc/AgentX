'use strict';

const mongoose = require('mongoose');
async function ensureInfrastructure() {
  const db = mongoose.connection;
  await db.collection('conversation_payload_chunks').createIndex({ owner: 1 });
  await db.collection('conversation_transcript_pages').createIndex({ owner: 1 });
  await db.collection('conversation_turn_identities').createIndex({ owner: 1 });
  await db.collection('conversation_exchange_receipts').createIndex({ scope: 1, createdAt: -1, _id: -1 });
  await db.collection('conversation_exchange_receipts').createIndex({ scope: 1, clientTurnId: 1 });
  await db.collection('conversation_exchange_receipts').createIndex({ conversationId: 1 });
  await db.collection('conversation_exchange_packets').createIndex({ receiptId: 1, scope: 1, sequence: 1 }, { unique: true });
}

module.exports = { ensureInfrastructure };
