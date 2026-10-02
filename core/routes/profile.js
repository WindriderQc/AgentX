const express = require('express');
const router = express.Router();
const { getUserId, getOrCreateProfile, saveProfile, PREFERENCE_FIELDS } = require('../src/helpers/userHelpers');
const { PROFILE_LIMITS } = require('../models/UserProfile');

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function checkText(value, name, limit) {
  if (value === undefined) return null;
  if (typeof value !== 'string') return `${name} must be a string`;
  if (value.length > limit) return `${name} must be at most ${limit} characters`;
  return null;
}

// Returns the first validation error, or null when the body is acceptable.
function validateProfileBody(body) {
  if (!isPlainObject(body)) return 'profile must be a JSON object';
  const aboutError = checkText(body.about, 'about', PROFILE_LIMITS.about);
  if (aboutError) return aboutError;
  if (body.preferences === undefined) return null;
  if (!isPlainObject(body.preferences)) return 'preferences must be an object';
  for (const field of PREFERENCE_FIELDS) {
    const error = checkText(body.preferences[field], `preferences.${field}`, PROFILE_LIMITS[field]);
    if (error) return error;
  }
  return null;
}

router.get('/', async (_req, res, next) => {
  try {
    const userId = getUserId(res);
    const profile = await getOrCreateProfile(userId);
    return res.json({ status: 'success', data: profile });
  } catch (err) {
    return next(err);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const validationError = validateProfileBody(req.body);
    if (validationError) {
      return res.status(400).json({ status: 'error', message: validationError });
    }
    const userId = getUserId(res);
    const profile = await saveProfile(userId, req.body);
    return res.json({ status: 'success', data: profile });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
