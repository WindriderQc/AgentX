'use strict';
const mongoose = require('mongoose');
const schema = new mongoose.Schema({ _id: String, inputHash: String, input: mongoose.Schema.Types.Mixed,
  libraryDispatched: Boolean, albumDispatched: Boolean, libraryId: String, albumId: String,
}, { timestamps: true, collection: 'photo_processing_setups' });
module.exports = mongoose.models.PhotoProcessingSetup || mongoose.model('PhotoProcessingSetup', schema);
