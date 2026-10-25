'use strict';

const access = require('./financeAccess');
const PROTOCOL = 'agentx.finance-maintenance/v1';
function origin(value) {
  let url;
  try { url = new URL(value); } catch { throw access.error('An explicit loopback Core origin is required', 'FINANCE_REPAIR_CORE_REQUIRED',400); }
  if (!['http:','https:'].includes(url.protocol) || !['127.0.0.1','localhost','[::1]'].includes(url.hostname)
    || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw access.error('Finance repair requires the native loopback Core origin', 'FINANCE_REPAIR_CORE_REQUIRED',400);
  }
  return url.origin;
}
async function request(base,path) {
  try {
    const response = await fetch(origin(base)+path,{signal:AbortSignal.timeout(3000),redirect:'error'});
    return {status:response.status,body:await response.json()};
  } catch { throw access.error('Core Finance exclusion could not be verified','FINANCE_REPAIR_CORE_UNQUALIFIED'); }
}
async function protocol(base) {
  const response = await request(base,'/api/finance/maintenance');
  const identity = (await access.state()).identity;
  if (response.status !== 200 || response.body.data?.protocol !== PROTOCOL || response.body.data?.databaseIdentity !== identity) {
    throw access.error('Core does not attest this Finance coordination database','FINANCE_REPAIR_CORE_UNQUALIFIED',409);
  }
}
async function fenced(base) {
  const response = await request(base,'/api/finance/inbox');
  if (response.status !== 503 || response.body.code !== 'FINANCE_MAINTENANCE') {
    throw access.error('The served Core still admits Finance during repair','FINANCE_REPAIR_CORE_UNQUALIFIED',409);
  }
}
module.exports = { PROTOCOL, protocol, fenced };
