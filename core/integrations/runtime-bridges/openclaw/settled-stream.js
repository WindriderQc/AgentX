'use strict';

const { Transform } = require('node:stream');
const { StringDecoder } = require('node:string_decoder');

// OpenClaw can start its next tool/model turn as soon as done:true arrives.
// Hold only that terminal frame until Core has durably released the admission.
// Ordinary content still streams; failed settlement never acknowledges success.
function settledStream(source, completion) {
  if (!completion) return source;
  void completion.catch(() => {});
  const decoder = new StringDecoder('utf8');
  let pending = '';
  let terminal = '';
  const consume = function (text, final = false) {
    pending += text;
    let newline;
    while ((newline = pending.indexOf('\n')) !== -1 || (final && pending)) {
      const end = newline === -1 ? pending.length : newline + 1;
      const frame = pending.slice(0, end);
      pending = pending.slice(end);
      let done = false;
      try { done = JSON.parse(frame).done === true; } catch { /* Core validates frames. */ }
      if (done) terminal += frame;
      else this.push(frame);
    }
  };
  const relay = new Transform({
    transform(chunk, _encoding, callback) {
      consume.call(this, decoder.write(chunk));
      callback();
    },
    flush(callback) {
      consume.call(this, decoder.end(), true);
      completion.then(() => { this.push(terminal); callback(); }, callback);
    }
  });
  source.once('error', error => relay.destroy(error));
  relay.once('close', () => { if (!source.readableEnded) source.resume(); });
  source.pipe(relay);
  return relay;
}

module.exports = { settledStream };
