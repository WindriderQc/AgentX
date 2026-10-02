'use strict';

const http = require('node:http');
const fetch = require('node-fetch');
const { destroyOutboundSockets, getFetchOptions } = require('../../src/helpers/httpAgent');

// A synthetic peer that accepts the request and never answers, like a jammed host.
let server;
let received = 0;
beforeAll(async () => {
  server = http.createServer(() => { received++; });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
});

test('shutdown closes orphaned outbound sockets through their agents (#17)', async () => {
  const url = `http://127.0.0.1:${server.address().port}/api/tags`;
  const viaGlobalAgent = fetch(url);
  const viaSharedAgent = fetch(url, getFetchOptions(url));
  const outcomes = Promise.allSettled([viaGlobalAgent, viaSharedAgent]);
  while (received < 2) await new Promise(resolve => setImmediate(resolve));
  const before = process.getActiveResourcesInfo().filter(type => type === 'TCPSocketWrap').length;

  destroyOutboundSockets();

  const results = await outcomes;
  expect(results.map(result => result.status)).toEqual(['rejected', 'rejected']);
  const after = process.getActiveResourcesInfo().filter(type => type === 'TCPSocketWrap').length;
  expect(after).toBeLessThan(before);
});
