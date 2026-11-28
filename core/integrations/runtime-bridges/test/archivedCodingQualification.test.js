'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { CodingDeliveryControl, localItem, mergeConfirmation } = require('../coding-delivery-control');
const { isArchivedQualification } = require('../archivedCodingQualification');
const head = 'a'.repeat(40);
const task = (id, disposition) => ({ pipelineId:id, title:'Fixture', status:'review',
  codingAutonomy:{ authorized:false, ...(disposition ? {disposition} : {}) },
  automationAttempts:[{attempt:1, finalState:'review', reviewOutcome:'pending',
    evidence:{verification:{status:'passed'}, failureCodes:[]}}] });
test('uses the existing qualification disposition, not synthetic titles or outcomes', () => {
  for (const outcome of ['passed','abandoned','failed','superseded',undefined]) {
    assert.equal(isArchivedQualification(task('0001',{kind:'qualification',outcome})),true);
    assert.equal(localItem(task('0001',{kind:'qualification',outcome}),'WindriderQc/AgentX'),null);
  }
  assert.equal(isArchivedQualification(null),false);
  assert.equal(isArchivedQualification(task('0002',{kind:'other'})),false);
  const active=task('0003'); active.title='Synthetic-looking but not archived';
  assert.equal(localItem(active,'WindriderQc/AgentX').humanActionRequired,true);
});
test('archived records do not contribute cards or decision counts and remain unchanged',async()=>{
  const archived=task('0001',{kind:'qualification',outcome:'passed'});
  const active=task('0002');
  const snapshot=JSON.stringify([archived,active]);
  const control=new CodingDeliveryControl({repository:'WindriderQc/AgentX',
    github:{configured:false}, taskReader:async()=>[archived,active],
    productionReader:async()=>({available:false})});
  const result=await control.status();
  assert.deepEqual(result.items.map(x=>x.pipelineId),['0002']);
  assert.deepEqual(result.counts,{total:1,humanActionRequired:1,readyToMerge:0});
  assert.equal(JSON.stringify([archived,active]),snapshot);
});
test('archived product-qualified records are filtered before product delivery lookups',async()=>{
  const archived=task('0001',{kind:'qualification',outcome:'passed'});
  archived.status='done'; archived.automation={policyRef:'product.fixture'};
  archived.automationAttempts[0].reviewOutcome='accepted'; archived.automationAttempts[0].evidence.workerReceiptFingerprint='b'.repeat(64);
  archived.feedback=[{by:'coding-promotion',text:'agentx.coding-promotion/v1 task=0001 attempt=1'+String.fromCharCode(10)+'Verified worker snapshot published as https://github.com/WindriderQc/AgentX-Ecosystem/pull/123.'}];
  let lookups=0;
  const control=new CodingDeliveryControl({repository:'WindriderQc/AgentX',
    github:{configured:false}, productGithub:{configured:true,getPull:async()=>{lookups++;throw Error('must not run');}},
    taskReader:async()=>[archived], productionReader:async()=>({available:false})});
  const result=await control.status();
  assert.deepEqual(result.items,[]);
  assert.deepEqual(result.counts,{total:0,humanActionRequired:0,readyToMerge:0});
  assert.equal(lookups,0);
});
test('direct merge cannot reactivate an archived qualification or contact GitHub',async()=>{
  const archived=task('0001',{kind:'qualification',outcome:'passed'});
  archived.status='done'; archived.automationAttempts[0].reviewOutcome='accepted'; archived.automationAttempts[0].evidence.workerReceiptFingerprint='b'.repeat(64);
  archived.feedback=[{by:'coding-promotion',text:'agentx.coding-promotion/v1 task=0001 attempt=1'+String.fromCharCode(10)+'Verified worker snapshot published as https://github.com/WindriderQc/AgentX/pull/123.'}];
  let calls=0;
  const control=new CodingDeliveryControl({repository:'WindriderQc/AgentX',
    github:{configured:true,mergePull:async()=>{calls++;}},taskReader:async()=>[archived],
    productionReader:async()=>{calls++;return {available:false};},receiptReader:async()=>{calls++;}});
  await assert.rejects(control.merge({pipelineId:'0001',pullRequestNumber:123,
    expectedHeadSha:head,confirmation:mergeConfirmation(123,head)}),
    error=>error.code==='CODING_DELIVERY_IDENTITY_MISMATCH');
  assert.equal(calls,0);
  assert.equal(control.merging.size,0);
});
