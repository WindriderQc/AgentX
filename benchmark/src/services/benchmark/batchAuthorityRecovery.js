/**
 * Batch authority recovery: durable reconciliation journaling and the
 * hand-off of an ambiguous workload admission to Core recovery quarantine.
 */

const logger = require('../../../config/logger');
const { transitionWorkloadRecovery } = require('../../clients/coreApiClient');
const authorityReconciliation = require('./benchmarkAuthorityReconciliation');

function markReconciliationPending(authorityError, compensationError, code, details = {}) {
    authorityError.compensationError = compensationError;
    authorityError.retainAdmission = true;
    authorityError.code = code;
    const workloadId = String(details.workloadId || details.batchId || '');
    const resultId = String(details.resultId || details.batchId || workloadId);
    if (workloadId && resultId) {
        authorityError.reconciliationPersistedPromise = authorityReconciliation.enqueueAuthorityInvalidation({
            kind: details.kind || 'batch_invalidation',
            resultId,
            batchId: details.batchId || workloadId,
            workloadId,
            phase: details.phase || code,
            reason: compensationError?.message || authorityError.message
        }).then(record => {
            authorityError.reconciliationId = String(record._id);
            authorityError.reconciliationPersisted = true;
            authorityError.reconciliationPromise = authorityReconciliation.waitForResultInvalidation(record._id);
            return record;
        }).catch(error => {
            authorityError.reconciliationError = error;
            authorityError.reconciliationPersisted = false;
            logger.error('Durable batch authority reconciliation could not be journaled; Core quarantine remains armed', {
                workloadId,
                resultId,
                code,
                error: error.message
            });
            // Preserve the failure on the owning error without creating an
            // unhandled rejection when the caller has already transferred
            // authority to Core quarantine. The lifecycle still observes
            // reconciliationPersisted=false and never releases that fence.
            return null;
        });
    }
    return authorityError;
}

function retainAdmissionHeartbeat(heartbeat, ttlMs, context = {}) {
    // Core recovery quarantine is durable and deliberately non-reaped. Stop
    // renewing the crashed process proof so a restarted CAS worker can adopt
    // it; the workload itself remains fenced until a verified restore receipt.
    const workloadId = String(context.workloadId || '');
    Promise.resolve()
        // The journal record goes first, while this process still holds the
        // recovery identity. A restart loses that identity, and a quarantine
        // handed over without a record is one no worker can adopt.
        .then(() => workloadId ? authorityReconciliation.enqueueAuthorityInvalidation({
            kind: 'batch_invalidation',
            resultId: workloadId,
            batchId: workloadId,
            workloadId,
            phase: context.phase || 'retained admission',
            reason: `workload admission retained for recovery (${context.phase || 'unspecified phase'})`
        }).catch(error => logger.error('Retained batch admission could not be journaled; the restart sweep rebuilds the record from Core', {
            ...context,
            error: error.message
        })) : null)
        .then(() => workloadId ? transitionWorkloadRecovery(workloadId, 'UNKNOWN', {
            receipt: {
                contract: 'agentx.workload-recovery/v1',
                event: 'owner-handoff-after-ambiguous-mutation',
                phase: context.phase || null
            }
        }) : null)
        .catch(error => logger.error('Could not hand batch recovery quarantine to the restart worker; fence remains', {
            ...context,
            error: error.message
        }))
        .finally(() => heartbeat.drain().catch(error => logger.error('Quarantined batch admission heartbeat drain failed', {
            ...context,
            error: error.message
        })));
    logger.error('Workload admission moved to durable Core recovery quarantine', context);
    return { retained: true, holdMs: null, recoveryRequired: true };
}

module.exports = { markReconciliationPending, retainAdmissionHeartbeat };
