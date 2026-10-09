'use strict';

// One address serves Core, Benchmark and RAG: the gateway routes `/benchmark`
// and `/rag` to their service without rewriting the path. Each service drops
// its own prefix first, so every route answers under the prefix (browsers) and
// at root (healthchecks, Core's container clients, on-host scripts).
function stripPathPrefix(prefix) {
  return function pathPrefix(req, _res, next) {
    const rest = req.url.slice(prefix.length);
    if (req.url.startsWith(prefix) && (rest === '' || rest[0] === '/' || rest[0] === '?')) {
      req.url = rest[0] === '/' ? rest : `/${rest}`;
    }
    next();
  };
}

module.exports = { stripPathPrefix };
