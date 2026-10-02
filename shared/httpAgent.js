'use strict';

const http = require('http');
const https = require('https');

const AGENT_CONFIG = Object.freeze({
  keepAlive: true,
  keepAliveMsecs: 1000,
  maxSockets: 10,
  maxFreeSockets: 2,
  timeout: 60000,
  scheduling: 'lifo'
});

const httpAgent = new http.Agent(AGENT_CONFIG);
const httpsAgent = new https.Agent(AGENT_CONFIG);

function getAgent(url) {
  if (!url) return null;
  return String(url).toLowerCase().startsWith('https://') ? httpsAgent : httpAgent;
}

function getFetchOptions(url, options = {}) {
  return { ...options, agent: getAgent(url) };
}

function destroyAgents() {
  httpAgent.destroy();
  httpsAgent.destroy();
}

// Outbound sockets belong to the agent that opened them: these shared agents,
// or Node's global agents for requests made without one. Once a server has
// drained its registered work, a socket still open is an orphaned request
// whose caller left; it must not keep the process alive.
function destroyOutboundSockets() {
  destroyAgents();
  http.globalAgent.destroy();
  https.globalAgent.destroy();
}

module.exports = {
  AGENT_CONFIG,
  destroyAgents,
  destroyOutboundSockets,
  getAgent,
  getFetchOptions,
  httpAgent,
  httpsAgent
};
