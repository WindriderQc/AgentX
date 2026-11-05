'use strict';

// The reader and reviewed repairs use the same raw monetary grouping. Coverage
// and calendar zeroes remain reader metadata, separate from stored money.
const { ledgerFilter, ledgerOf } = require('./ledgers');
const { error } = require('./financeAccess');

function totalsStage() {
  return { _id:null, count:{$sum:1},
    inCents:{$sum:{$cond:[{$gt:['$flowCents',0]},'$flowCents',0]}},
    outCents:{$sum:{$cond:[{$lt:['$flowCents',0]},'$flowCents',0]}},
    netCents:{$sum:'$flowCents'} };
}
function monthlyPipeline(filter) {
  return [{$match:filter},{$group:{...totalsStage(),_id:{$substrBytes:['$date',0,7]}}},{$sort:{_id:1}}];
}
const conflict = () => error('Monthly money exceeds the reviewed safe integer projection','FINANCE_REPAIR_STATE_CONFLICT',409);
function projectMonthly(rows) {
  const books = {perso:new Map(),corp:new Map()};
  for (const row of rows) {
    if (typeof row.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(row.date)
      || !(row.flowCents === null || row.flowCents === undefined || Number.isSafeInteger(row.flowCents))) throw conflict();
    const month=row.date.slice(0,7), book=books[ledgerOf(row.ledger)], flow=row.flowCents ?? 0;
    const total=book.get(month) || {month,count:0,inCents:0,outCents:0,netCents:0};
    total.count++; total.inCents+=Math.max(0,flow); total.outCents+=Math.min(0,flow); total.netCents+=flow;
    if (![total.count,total.inCents,total.outCents,total.netCents].every(Number.isSafeInteger)) throw conflict();
    book.set(month,total);
  }
  return Object.fromEntries(Object.entries(books).map(([ledger,months])=>[ledger,[...months.values()].sort((a,b)=>a.month.localeCompare(b.month))]));
}
async function nativeMonthly(db) {
  const result={};
  for (const ledger of ['perso','corp']) {
    const rows=await db.collection('finance_transactions').aggregate(monthlyPipeline(ledgerFilter(ledger))).toArray();
    result[ledger]=rows.map(({_id,...totals})=>({month:_id,...totals}));
  }
  return result;
}
module.exports={totalsStage,monthlyPipeline,projectMonthly,nativeMonthly};
