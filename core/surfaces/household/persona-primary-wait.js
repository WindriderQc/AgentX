'use strict';

// Release the HTTP foreground on barge-in while Core retains the admitted Main
// request. This never aborts the observer's independent native transport.
function primaryWait({ entry, works, sessionId, res, activePersonaTurns }) {
  entry.detach = () => {
    if (!entry.primaryWaiting || entry.primaryDetached || entry.executionSettled || entry.abort.signal.aborted) return false;
    entry.primaryDetached = true; entry.interrupted = true; entry.abort.abort();
    if (activePersonaTurns.get(sessionId) === entry) activePersonaTurns.delete(sessionId);
    if (!res.writableEnded) res.end();
    return true;
  };
  return async () => {
    entry.primaryWaiting = true;
    try {
      const result = await works.primaryReply(entry.workId, { signal: entry.abort.signal });
      entry.primaryWaiting = false;
      return result;
    } catch (cause) {
      if (entry.abort.signal.aborted) entry.primaryDetached = true;
      entry.primaryWaiting = false;
      throw cause;
    }
  };
}

module.exports = { primaryWait };
