/**
 * Benchmark Routes - Diagnostics shared helpers
 * Workload admission options and admission-guarded calibration persistence.
 */

const mongoose = require('mongoose');
const JudgeAccuracyMatrix = require('../../models/JudgeAccuracyMatrix');
const diagnosticWorkloadOptions = req => ({
    batchId: req.body?.batch_id || null,
    hosts: [
        req.body?.judge_host,
        req.body?.reference_host,
        req.query?.judge_host,
        req.query?.reference_host
    ].filter(Boolean)
});

function calibrationTargetKey(target) {
    const host = String(target?.host || '').trim().replace(/\/+$/, '').toLowerCase();
    const model = String(target?.model || '').trim().toLowerCase();
    return `${host}@@${model}`;
}

async function persistCalibrationUnderAdmission(payload, req) {
    const id = new mongoose.Types.ObjectId();
    req.assertWorkloadAdmissionActive?.();
    try {
        const created = await JudgeAccuracyMatrix.create(
            [{ _id: id, ...payload }],
            req.workloadAdmissionSignal ? { signal: req.workloadAdmissionSignal } : undefined
        );
        req.assertWorkloadAdmissionActive?.();
        return Array.isArray(created) ? created[0] : created;
    } catch (error) {
        if (req.workloadAdmissionSignal?.aborted
            || error?.code === 'BENCHMARK_CLAIM_LOST'
            || error?.code === 'BENCHMARK_CLAIM_STOPPED') {
            try {
                await JudgeAccuracyMatrix.updateOne(
                    { _id: id },
                    {
                        $set: {
                            authority_state: 'authority_invalidated',
                            authority_reconciliation_reason: 'diagnostic calibration raced workload admission loss'
                        }
                    },
                    { upsert: true }
                );
                error.authorityCompensated = true;
            } catch (compensationError) {
                error.compensationError = compensationError;
                error.retainAdmission = true;
                error.code = 'JUDGE_MATRIX_RECONCILIATION_PENDING';
            }
        }
        throw error;
    }
}

module.exports = {
    diagnosticWorkloadOptions,
    calibrationTargetKey,
    persistCalibrationUnderAdmission
};
