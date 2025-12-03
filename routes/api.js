const express = require('express');
const router = express.Router();
const Conversation = require('../models/Conversation');
const UserProfile = require('../models/UserProfile');
const fetch = (...args) => import('node-fetch').then(({ default: fn }) => fn(...args));

// Helper to sanitize Ollama options
function sanitizeOptions(options = {}) {
  const numericKeys = [
    'temperature', 'top_k', 'top_p', 'num_ctx', 'repeat_penalty',
    'presence_penalty', 'frequency_penalty', 'seed', 'num_predict',
    'typical_p', 'tfs_z', 'mirostat', 'mirostat_eta', 'mirostat_tau'
  ];
  const clean = {};
  numericKeys.forEach((key) => {
    if (options[key] === 0 || options[key]) {
      const parsed = Number(options[key]);
      if (!Number.isNaN(parsed)) clean[key] = parsed;
    }
  });
  if (Array.isArray(options.stop)) clean.stop = options.stop;
  else if (typeof options.stop === 'string' && options.stop.trim()) {
    clean.stop = options.stop.split(',').map((val) => val.trim()).filter(Boolean);
  }
  if (options.keep_alive) clean.keep_alive = options.keep_alive;
  return clean;
}

// Resolve Ollama Target
function resolveTarget(target) {
    const fallback = 'http://localhost:11434';
    if (!target || typeof target !== 'string') return fallback;
    const trimmed = target.trim();
    if (!trimmed) return fallback;
    if (/^https?:\/\//i.test(trimmed)) return trimmed.replace(/\/+$/, '');
    return `http://${trimmed.replace(/\/+$/, '')}`;
}

// PROXY: Models List
router.get('/ollama/models', async (req, res) => {
    const target = req.query.target || 'localhost:11434';
    try {
        const url = `${resolveTarget(target)}/api/tags`;
        const response = await fetch(url);
        const data = await response.json();
        const models = Array.isArray(data?.models)
            ? data.models.map((model) => ({
                name: model.name,
                size: model.size,
                modified_at: model.modified_at,
            }))
            : [];
        res.json({ status: 'success', data: models });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

// CHAT: Enhanced with Memory & Logging
router.post('/chat', async (req, res) => {
  const { target = 'localhost:11434', model, messages = [], system, options = {}, conversationId } = req.body;
  const userId = 'default'; // Hardcoded for single user V1/V2

  if (!model) return res.status(400).json({ status: 'error', message: 'Model is required' });

  try {
    // 1. Fetch User Profile
    let userProfile = await UserProfile.findOne({ userId });
    if (!userProfile) {
        userProfile = await UserProfile.create({ userId });
    }

    // 2. Inject Memory into System Prompt
    let effectiveSystemPrompt = system || 'You are AgentX, an efficient local AI assistant.';
    if (userProfile.about) {
        effectiveSystemPrompt += `\n\nUser Profile/Memory:\n${userProfile.about}`;
    }
    if (userProfile.preferences?.customInstructions) {
        effectiveSystemPrompt += `\n\nCustom Instructions:\n${userProfile.preferences.customInstructions}`;
    }

    // 3. Prepare Payload for Ollama
    const formattedMessages = [
        { role: 'system', content: effectiveSystemPrompt },
        ...messages.map(m => ({ role: m.role, content: m.content }))
    ];

    const ollamaPayload = {
        model,
        messages: formattedMessages,
        stream: false,
        options: sanitizeOptions(options),
    };

    // 4. Call Ollama
    const url = `${resolveTarget(target)}/api/chat`;
    const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(ollamaPayload),
    });

    if (!response.ok) throw new Error(`Ollama request failed: ${response.statusText}`);
    const data = await response.json();
    const assistantMessageContent = data.message?.content || data.response || '';

    // 5. Save to DB
    let conversation;
    if (conversationId) {
        conversation = await Conversation.findById(conversationId);
    }

    // If no ID or not found, create new
    if (!conversation) {
        conversation = new Conversation({
            userId,
            model,
            systemPrompt: effectiveSystemPrompt,
            messages: []
        });
    }

    // Append new messages (User's last message + Assistant's response)
    // We assume the frontend sends the whole history, but we only want to append the *new* stuff or
    // maybe just rebuild the conversation?
    // Best practice for "Log everything":
    // The Frontend sends the full context for the LLM.
    // BUT for our DB, we want to store the structured conversation.
    // If the frontend sends the *last* user message separately, it's easier.
    // However, the current `app.js` sends `messages: state.history`.
    // `state.history` contains everything.

    // Let's assume for this endpoint, we want to log the *latest* exchange.
    // We should probably change the API contract slightly:
    // Frontend sends: { message: "latest user input", history: [prev...], ... }
    // OR we just take the last message from the array if it is role 'user'.

    const lastUserMsg = messages[messages.length - 1];
    if (lastUserMsg && lastUserMsg.role === 'user') {
         conversation.messages.push({ role: 'user', content: lastUserMsg.content });
    }

    conversation.messages.push({ role: 'assistant', content: assistantMessageContent });

    // Generate title if new
    if (conversation.messages.length <= 2) {
        conversation.title = (lastUserMsg?.content || 'New Conversation').substring(0, 50);
    }

    await conversation.save();

    // 6. Return response
    res.json({
        status: 'success',
        data: data,
        conversationId: conversation._id
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// HISTORY: Get list
router.get('/history', async (req, res) => {
    try {
        const conversations = await Conversation.find({ userId: 'default' })
            .sort({ updatedAt: -1 })
            .limit(50)
            .select('title updatedAt model messages'); // Select fields to return

        // Transform for frontend preview
        const previews = conversations.map(c => ({
            id: c._id,
            title: c.title,
            date: c.updatedAt,
            model: c.model,
            preview: c.messages[c.messages.length - 1]?.content.substring(0, 60) + '...'
        }));

        res.json({ status: 'success', data: previews });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

// HISTORY: Get single
router.get('/history/:id', async (req, res) => {
    try {
        const conversation = await Conversation.findById(req.params.id);
        if(!conversation) return res.status(404).json({status: 'error', message: 'Not found'});
        res.json({ status: 'success', data: conversation });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

// FEEDBACK
router.post('/feedback', async (req, res) => {
    const { conversationId, messageId, rating, comment } = req.body;
    try {
        const conversation = await Conversation.findById(conversationId);
        if (!conversation) return res.status(404).json({ status: 'error', message: 'Conversation not found' });

        // Find the message. Since we might not have stable IDs for subdocuments if we just push,
        // we can use the `_id` of the subdocument if Mongoose adds it (it does by default).
        const msg = conversation.messages.id(messageId);
        if (!msg) return res.status(404).json({ status: 'error', message: 'Message not found' });

        msg.feedback = { rating, comment };
        await conversation.save();

        res.json({ status: 'success', message: 'Feedback saved' });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

// PROFILE
router.get('/profile', async (req, res) => {
    try {
        let profile = await UserProfile.findOne({ userId: 'default' });
        if (!profile) profile = await UserProfile.create({ userId: 'default' });
        res.json({ status: 'success', data: profile });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

router.post('/profile', async (req, res) => {
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

module.exports = router;
