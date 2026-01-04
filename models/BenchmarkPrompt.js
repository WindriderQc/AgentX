const mongoose = require('mongoose');

const BenchmarkPromptSchema = new mongoose.Schema({
    prompt: { type: String, required: true },
    expected_answer: { type: String }, // For factual checking
    level: { type: Number, required: true, min: 1, max: 5 }, // 1=Easy, 5=Hard
    category: {
        type: String,
        required: true,
        enum: ['reasoning', 'coding', 'factual', 'math', 'creative', 'general']
    },
    name: { type: String }, // Short name for display
    created_at: { type: Date, default: Date.now },
    custom: { type: Boolean, default: false }, // User-defined prompt
    scoring_type: {
        type: String,
        enum: ['reasoning', 'code', 'coding', 'factual', 'math', 'creative'],
        default: 'reasoning'
    }
});

BenchmarkPromptSchema.index({ level: 1 });
BenchmarkPromptSchema.index({ category: 1 });

module.exports = mongoose.model('BenchmarkPrompt', BenchmarkPromptSchema);
