'use strict';

const mongoose = require('mongoose');

// The owner's financial plan: budget, debts, credit lines, annual provisions,
// assets and milestones. One document; the ledger supplies live balances and
// actuals, this supplies the intent. Values stay in the instance database.
const financePlanSchema = new mongoose.Schema({
  _id: { type: String, default: 'plan' },
  phase: { type: String, default: '' },
  excludeTags: { type: [String], default: ['refi'] },
  budget: { type: [mongoose.Schema.Types.Mixed], default: [] },
  debts: { type: [mongoose.Schema.Types.Mixed], default: [] },
  credit: { type: [mongoose.Schema.Types.Mixed], default: [] },
  provisions: { type: [mongoose.Schema.Types.Mixed], default: [] },
  assets: { type: [mongoose.Schema.Types.Mixed], default: [] },
  milestones: { type: [mongoose.Schema.Types.Mixed], default: [] },
  openItems: { type: [mongoose.Schema.Types.Mixed], default: [] },
  allocations: { type: [mongoose.Schema.Types.Mixed], default: [] },
  watch: { type: [mongoose.Schema.Types.Mixed], default: [] },
  taxRoom: { type: [mongoose.Schema.Types.Mixed], default: [] }
}, { timestamps: true, minimize: false });

module.exports = mongoose.models.FinancePlan
  || mongoose.model('FinancePlan', financePlanSchema, 'finance_plan');
