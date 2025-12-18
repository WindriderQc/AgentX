const express = require('express');
const router = express.Router();
const UserProfile = require('../models/UserProfile');
const { getUserId, getOrCreateProfile } = require('../src/helpers/userHelpers');
const { optionalAuth } = require('../src/middleware/auth');

// PROFILE
router.get('/', async (req, res) => {
    try {
        const profile = await getOrCreateProfile('default');
        res.json({ status: 'success', data: profile });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

router.post('/', async (req, res) => {
    const { about, preferences } = req.body;
    try {
        const profile = await UserProfile.findOneAndUpdate(
            { userId: 'default' },
            { $set: { about, preferences, updatedAt: Date.now() } },
            { new: true, upsert: true }
        );
        res.json({ status: 'success', data: profile });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

// Alias for frontend compatibility
router.get('/user', optionalAuth, async (req, res) => {
    try {
        const userId = getUserId(res);
        const profile = await getOrCreateProfile(userId);
        res.json({ status: 'success', data: profile });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

module.exports = router;
