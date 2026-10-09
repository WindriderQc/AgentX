'use strict';

const mongoose = require('mongoose');
const express = require('express');
const { durableConversationExchange } = require('../../src/middleware/durableConversationExchange');

(async () => {
  await mongoose.connect(process.env.EXCHANGE_TEST_MONGO_URI);
  const app = express();
  app.use(express.json());
  app.use(durableConversationExchange({ scope: () => 'synthetic:process-crash' }));
  app.post('/chat', (_req, res) => {
    res.type('text/event-stream');
    res.write('event: token\ndata: {"content":"réponse partielle"}\n\n', () => {
      process.send({ event: 'delivered', receiptId: res.locals.exchangeReceiptId });
    });
    // The parent terminates this process after Mongo acknowledgement and delivery.
  });
  const server = app.listen(0, '127.0.0.1', () => process.send({ event: 'ready', port: server.address().port }));
})().catch(error => { process.stderr.write(error.message); process.exit(1); });
