'use strict';

const path = require('node:path');
const { safeDirectory, fail } = require('./importFiles');
const { id, read, optional, hash } = require('./phoneLibrary');

function createPhoneCleanup(library) {
  async function prepared(planId) {
    return read(path.join(library.state, 'cleanup', id(planId), 'value.json'));
  }
  async function prepare(input) {
    id(input.planId);
    id(input.runId);
    if (
      !Array.isArray(input.items) ||
      !input.items.length ||
      input.items.length > 100 ||
      new Set(input.items).size !== input.items.length
    )
      throw fail('INVALID_SELECTION', 'Select 1–100 exact files');
    const selection = input.items.map(id).sort();
    const previous = await optional(path.join(library.state, 'cleanup', input.planId, 'value.json'));
    if (previous) {
      if (
        previous.runId !== input.runId ||
        hash(previous.items.map((x) => x.requestId).sort()) !== hash(selection)
      )
        throw fail('REQUEST_CONFLICT', 'The selection has changed');
      return previous;
    }
    const run = await library.manifest(input.runId);
    const selectedSources = selection.map((requestId) =>
      run.sources.find((item) => item.requestId === requestId),
    );
    if (selectedSources.some((item) => !item))
      throw fail('SOURCE_NOT_FOUND', 'Source is outside this import');
    if (selectedSources.reduce((total, item) => total + item.size, 0) > 2 * 1024 * 1024 * 1024)
      throw fail('INVALID_SELECTION', 'Prepare a smaller cleanup batch (2 GiB maximum)');
    const items = [];
    for (const requestId of selection) {
      const { source, receipt } = await library.occurrence(input.runId, requestId, true);
      if ((await library.phoneState(run, source, receipt)) !== 'not-requested')
        throw fail(
          'SOURCE_CLEANUP_HELD',
          'This phone source already has a cleanup receipt or an unresolved operation',
        );
      items.push({ ...source, sha256: receipt.sha256 });
    }
    const plan = {
      planId: input.planId,
      runId: input.runId,
      deviceKey: run.deviceKey,
      items,
      bytes: items.reduce((n, x) => n + x.size, 0),
      createdAt: new Date().toISOString(),
      confirmation: `SUPPRIMER ${items.length}`,
    };
    plan.digest = hash(plan);
    const dir = await safeDirectory(library.root, '.agentx-import/phone/cleanup');
    return library.immutable(dir, plan.planId, plan);
  }
  async function authorize(input) {
    const plan = await prepared(input.planId);
    id(input.operationId);
    id(input.requestId);
    id(input.attemptId);
    if (input.digest !== plan.digest || input.confirmation !== plan.confirmation)
      throw fail('CONFIRMATION_REQUIRED', 'Confirm the exact displayed selection');
    const item = plan.items.find((x) => x.requestId === input.requestId);
    if (!item || input.sha256 !== item.sha256)
      throw fail('SOURCE_CHANGED', 'Phone bytes differ from the selected backup');
    // This readback occurs after native phone hashing, immediately before its
    // writer receives a grant. A prepared plan alone authorizes no deletion.
    await library.occurrence(plan.runId, item.requestId, true);
    const claims = await safeDirectory(library.root, '.agentx-import/phone/claims');
    const claim = {
      planId: plan.planId,
      operationId: input.operationId,
      digest: plan.digest,
      requestId: item.requestId,
      attemptId: input.attemptId,
    };
    await library.immutable(claims, library.subjectKey(plan, item, item.sha256), claim);
    const dir = await safeDirectory(library.root, `.agentx-import/phone/cleanup/${plan.planId}/grants`);
    return library.immutable(dir, item.requestId, { ...claim, sha256: item.sha256, size: item.size });
  }
  async function record(input) {
    const plan = await prepared(input.planId);
    id(input.operationId);
    id(input.requestId);
    const grant = await read(
      path.join(library.state, 'cleanup', plan.planId, 'grants', input.requestId, 'value.json'),
    );
    if (
      grant.operationId !== input.operationId ||
      grant.attemptId !== input.attemptId ||
      grant.digest !== input.digest ||
      grant.sha256 !== input.sha256 ||
      input.state !== 'deleted'
    )
      throw fail('INVALID_DELETE_RECEIPT', 'A matching native success receipt is required');
    const dir = await safeDirectory(library.root, `.agentx-import/phone/cleanup/${plan.planId}/results`);
    return library.immutable(dir, input.requestId, { ...grant, state: 'deleted' });
  }
  async function status(input) {
    const plan = await prepared(input.planId),
      results = [];
    for (const item of plan.items) {
      const result = await optional(
        path.join(library.state, 'cleanup', plan.planId, 'results', item.requestId, 'value.json'),
      );
      const grant = await optional(
        path.join(library.state, 'cleanup', plan.planId, 'grants', item.requestId, 'value.json'),
      );
      results.push({
        requestId: item.requestId,
        state: result ? 'deleted' : grant ? 'uncertain' : 'not-started',
      });
    }
    return {
      planId: plan.planId,
      results,
      deleted: results.filter((x) => x.state === 'deleted').length,
      confirmedBytes: plan.items
        .filter((x) => results.find((r) => r.requestId === x.requestId)?.state === 'deleted')
        .reduce((n, x) => n + x.size, 0),
    };
  }
  return { prepare, prepared, authorize, record, status };
}

module.exports = { createPhoneCleanup };
