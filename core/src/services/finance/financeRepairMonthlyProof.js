'use strict';

const { canonical, hash } = require('./financeRepairStorage');
const { error } = require('./financeAccess');
const money = require('./financeMoneyTotals');
const conflict = () => error('The reviewed statement monthly money changed','FINANCE_REPAIR_STATE_CONFLICT',409);

async function plan(db,manifest,state,target,direction='apply') {
  const before=await money.nativeMonthly(db), expected=manifest.expectedAccounting.monthlyProjection;
  if (canonical(money.projectMonthly(state.finance_transactions))!==canonical(before)
    || (direction==='apply' && hash(before)!==expected.beforeSha256)
    || hash(money.projectMonthly(target.finance_transactions))!==(direction==='apply'?expected.afterSha256:expected.beforeSha256)) throw conflict();
  return before;
}
async function result(db,manifest,before,direction='apply') {
  const after=await money.nativeMonthly(db), expected=manifest.expectedAccounting.monthlyProjection;
  if ((direction==='apply' && hash(before)!==expected.beforeSha256)
    || hash(after)!==(direction==='apply'?expected.afterSha256:expected.beforeSha256)) throw conflict();
  return {reviewedMonthlyProjectionMatched:true,monthlyProjectionBeforeSha256:hash(before),monthlyProjectionAfterSha256:hash(after)};
}
module.exports={plan,result};
