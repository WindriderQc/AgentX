const mongoose = require('mongoose');

const remediationActionSchema = new mongoose.Schema({
    issueType: { type: String, required: true },
    severity: { type: String, required: true, enum: ['low', 'medium', 'high', 'critical'] },
    context: { type: Object, default: {} },
    strategy: { type: String, required: true },
    action: { type: String, required: true },
    automatedExecution: { type: Boolean, default: false },
    status: { type: String, default: 'pending', enum: ['pending', 'succeeded', 'failed'] },
    error: { type: String, default: null }
}, { timestamps: true });

module.exports = {
    RemediationAction: mongoose.model('RemediationAction', remediationActionSchema)
};
