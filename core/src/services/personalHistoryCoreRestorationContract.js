'use strict';

const { selection: globalSelection } = require('./personalHistoryGlobalDecisions');
const { digest, failure } = require('./personalHistorySourceReviewSources');
const messageScope = require('./personalHistoryMessageScope');
const downstream = require('./personalHistoryDownstreamScope');
const history = require('./personalHistoryService');
const CONTRACT = 'agentx.history-core-restoration/v1';
const changed = () => failure('The complete selected Core state changed during restoration.', 409, 'HISTORY_CORE_RESTORATION_CHANGED');

function selection(input) {
  const { expectedBindingsSha256, ...rest } = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  if (expectedBindingsSha256 !== undefined && (typeof expectedBindingsSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(expectedBindingsSha256))) {
    throw failure('Use only a native selected binding fingerprint.', 400, 'HISTORY_CORE_RESTORATION_INVALID');
  }
  return globalSelection(rest);
}

function bindings(sources, selected) {
  if (selected.messages.some(row => row.members.some(pin => pin.sourceBinding !== 'exact'))) throw changed();
  const members = selected.messages.map(({ reference, members: pins }) => {
    const ids = new Set(pins.map(pin => pin.entryId));
    return { reference, coreScope: { contract: messageScope.CONTRACT,
      fingerprint: digest({ contract: messageScope.CONTRACT, reference, entries: pins }), members: pins },
    entries: downstream.links(selected.rows.filter(row => ids.has(String(row._id))).map(history.project), selected.souvenirs, pins) };
  });
  return { sources, sourceSetSha256: digest(sources), members };
}

module.exports = { CONTRACT, selection, bindings, changed };
