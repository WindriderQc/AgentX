'use strict';

const receipts = require('../services/conversations/exchangeReceipts');
const { withRequestReceipt } = require('../services/conversations/exchangeContext');
const { trackDelivery, waitForDelivery } = require('../services/conversations/exchangeDeliveryRegistry');
async function ownedConversation(scope, id) {
  if (!/^[a-f0-9]{24}$/i.test(String(id || ''))) return null;
  const userId = scope.startsWith('playground:') ? scope.slice(11) : scope.startsWith('psyx:') ? `surface:psyx:${scope.slice(5)}` : null;
  if (!userId) return null;
  const model = require('../../models/Conversation');
  const row = await model.findOne({ _id: id, userId, surface: { $exists: false } }, '_id');
  return row ? String(id) : null;
}

const MAX_PENDING_BYTES = 4 * 1024 * 1024;

// Install after the route's authentication. Each response packet is confirmed
// in Core before it becomes visible to the client, including errors/refusals.
function durableConversationExchange({ scope, conversation, matches = req => req.method === 'POST', store = receipts } = {}) {
  return async (req, res, next) => {
    if (!matches(req)) return next();
    let accepted;
    try {
      const owner = await scope(req, res);
      const conversationId = conversation ? await conversation(req, res) : store === receipts ? await ownedConversation(owner, req.body?.conversationId || req.query?.conversationId) : null;
      accepted = await store.accept(owner, { path: req.originalUrl || req.url, method: req.method,
        body: req.body || {}, ...(req.method === 'GET' ? { query: req.query } : {}) },
      req.get?.('idempotency-key') || req.body?.clientTurnId || req.body?.requestId, conversationId);
      if (req.aborted || res.destroyed) {
        if (!accepted.duplicate) await store.finish(accepted.receipt, 'interrupted', { statusCode: 499, contentType: null, packets: 0 });
        return;
      }
      res.setHeader('X-AgentX-Receipt-Id', accepted.receipt._id);
      res.setHeader('Cache-Control', 'private, no-store');
      if (accepted.duplicate) {
        await waitForDelivery(accepted.receipt._id);
        const saved = await store.read(owner, accepted.receipt._id);
        if (!saved) return res.status(410).json({ status: 'error', code: 'EXCHANGE_ERASED',
          message: 'This exchange was erased and cannot be replayed.' });
        if (!saved.complete) return res.status(409).json({ status: 'error', code: 'EXCHANGE_OUTCOME_UNKNOWN',
          receiptId: saved.id, message: 'The original request and received response are preserved. Its completion is unknown; it was not executed again.' });
        res.status(saved.response.statusCode);
        if (saved.response.contentType) res.setHeader('Content-Type', saved.response.contentType);
        res.setHeader('X-AgentX-Receipt-Replayed', 'true');
        return res.end(saved.response.body);
      }
    } catch (error) {
      return res.status(error.statusCode || 503).json({ status: 'error', code: error.code || 'EXCHANGE_SAVE_FAILED',
        message: error.statusCode && error.statusCode < 500 ? error.message : 'The complete request could not be saved. No processing was started; keep the original and retry.' });
    }

    const receipt = accepted.receipt;
    const settled = trackDelivery(receipt._id);
    const write = res.write.bind(res), end = res.end.bind(res);
    let chain = Promise.resolve(), pending = 0, sequence = 0, ending = false, failed = false, deliveryStopped = false;
    const response = () => ({ statusCode: res.statusCode, contentType: res.getHeader('Content-Type') || null, packets: sequence, ...(res.locals.exchangeConversationId ? { conversationId: res.locals.exchangeConversationId } : {}) });
    function storageFailed(error) {
      if (failed) return;
      failed = true;
      settled();
      // Closing the stream is an explicit transport failure. It must not look
      // like a successful done event, and it must stop downstream generation.
      res.destroy(error);
    }
    function enqueue(data, encoding, callback, terminal = false) {
      const bytes = data == null ? Buffer.alloc(0) : typeof data === 'string'
        ? Buffer.from(data, encoding || 'utf8') : Buffer.from(data);
      const stopDelivery = pending > 0 && pending + bytes.length > MAX_PENDING_BYTES;
      if (stopDelivery) deliveryStopped = true;
      pending += bytes.length;
      chain = chain.then(async () => {
        if (failed) return;
        // Large non-stream replies are paged just like streamed deltas.
        for (let offset = 0; offset < bytes.length; offset += 256 * 1024) {
          await store.append(receipt, sequence++, bytes.subarray(offset, offset + 256 * 1024));
        }
        pending -= bytes.length;
        if (terminal) {
          await store.finish(receipt, deliveryStopped ? 'interrupted' : 'completed', response());
          settled();
          if (!res.destroyed) end(bytes, callback);
        } else if (!res.destroyed) {
          if (!write(bytes, callback)) await new Promise(resolve => {
            const ready = () => { res.off('drain', ready); res.off('close', ready); resolve(); };
            res.once('drain', ready); res.once('close', ready);
          });
          res.emit('drain');
        }
      }).catch(storageFailed);
      if (stopDelivery) res.destroy(Object.assign(new Error('Durable response backlog exceeded; received bytes are being preserved and delivery stopped.'), { code: 'EXCHANGE_BACKPRESSURE' }));
      return !deliveryStopped && pending < MAX_PENDING_BYTES;
    }
    res.write = (data, encoding, callback) => ending || failed || deliveryStopped ? false
      : enqueue(data, typeof encoding === 'string' ? encoding : undefined,
        typeof encoding === 'function' ? encoding : callback);
    res.end = (data, encoding, callback) => {
      if (ending || failed || deliveryStopped) return res;
      ending = true;
      enqueue(typeof data === 'function' ? undefined : data, typeof encoding === 'string' ? encoding : undefined,
        typeof data === 'function' ? data : typeof encoding === 'function' ? encoding : callback, true);
      return res;
    };
    res.once('close', () => {
      if (!ending || failed) chain.then(() => store.finish(receipt, 'interrupted', response())).catch(() => {}).finally(settled);
      else settled();
    });
    res.locals.exchangeReceiptId = receipt._id;
    withRequestReceipt(receipt, next);
  };
}

module.exports = { durableConversationExchange, MAX_PENDING_BYTES };
