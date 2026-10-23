'use strict';
const mongoose = require('mongoose');
// Action receipts only. Google retains calendar data, recurrence and guest delivery.
const schema = new mongoose.Schema({
  _id: { type: String, required: true }, fingerprint: { type: String, required: true },
  action: { type: String, required: true }, calendarId: { type: String, required: true },
  eventId: { type: String, required: true }, scope: { type: String, required: true },
  state: { type: String, enum: ['uncertain', 'completed', 'refused'], required: true },
  result: mongoose.Schema.Types.Mixed, error: mongoose.Schema.Types.Mixed
}, { collection: 'personal_calendar_operations', timestamps: true, versionKey: false });
module.exports = mongoose.models.PersonalCalendarOperation || mongoose.model('PersonalCalendarOperation', schema);
