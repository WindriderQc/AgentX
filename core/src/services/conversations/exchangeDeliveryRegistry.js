'use strict';

const pending = new Map();

// This process-local registry only coalesces a retry with its still-running
// local response. Mongo fences remain the sole write/erasure authority. A
// missing owner never authorizes a second inference after a crash.
function trackDelivery(id) {
  let resolve;
  const completed = new Promise(done => { resolve = done; });
  pending.set(id, completed);
  return () => {
    resolve();
    if (pending.get(id) === completed) pending.delete(id);
  };
}
async function waitForDelivery(id, waitMs = 5000) {
  const completed = pending.get(id);
  if (!completed) return;
  let timer;
  try {
    await Promise.race([completed, new Promise(resolve => { timer = setTimeout(resolve, waitMs); })]);
  } finally { clearTimeout(timer); }
}

module.exports = { trackDelivery, waitForDelivery };
