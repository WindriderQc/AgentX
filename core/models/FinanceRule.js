'use strict';

const mongoose = require('mongoose');

// Categorization rule learned from the owner: every transaction whose
// normalized description contains `pattern` gets this category and tags.
// The longest matching pattern wins.
const financeRuleSchema = new mongoose.Schema({
  pattern: { type: String, required: true, unique: true },
  category: { type: String, required: true },
  tags: { type: [String], default: [] },
  createdBy: { type: String, default: 'owner' }
}, { timestamps: true });

module.exports = mongoose.models.FinanceRule
  || mongoose.model('FinanceRule', financeRuleSchema, 'finance_rules');
