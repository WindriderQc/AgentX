'use strict';

const mongoose = require('mongoose');

// Face descriptors (128 numbers each) of the adult allowed to unlock by camera.
// No image is kept. Erasing the enrollment deletes the document.
const FaceEnrollmentSchema = new mongoose.Schema({
  subject: { type: String, required: true, unique: true },
  descriptors: { type: [[Number]], default: [] }
}, { timestamps: true, collection: 'access_face_enrollments' });

module.exports = mongoose.model('FaceEnrollment', FaceEnrollmentSchema);
