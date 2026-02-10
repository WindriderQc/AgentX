/**
 * Image Generation Handler
 * Visual LLM image generation via Ollama
 */

const fetch = require('node-fetch');
const fs = require('fs').promises;
const path = require('path');
const logger = require('../../../config/logger');
const { resolveTarget } = require('../../utils');

/**
 * Handle image generation request via visual_llm persona
 *
 * @param {Object} params - Generation parameters
 * @param {string} params.message - User prompt for image
 * @param {string} params.effectiveModel - Model to use
 * @param {string} params.effectiveTarget - Ollama target host
 * @param {string} params.conversationId - Optional conversation ID
 * @returns {Promise<Object>} { response, attachments, conversationId, assistantMessageId }
 */
async function handleImageGeneration({ message, effectiveModel, effectiveTarget, conversationId }) {
    const imageTarget = process.env.OLLAMA_HOST_2 || resolveTarget(effectiveTarget);
    const generatedDir = path.join(__dirname, '../../../public/generated');
    await fs.mkdir(generatedDir, { recursive: true });

    let data;
    if (effectiveModel === 'x/flux2-klein:9b' || effectiveModel === 'flux2-klein:9b') {
        const url = `${imageTarget}/api/chat`;
        const payload = {
            model: effectiveModel,
            messages: [{ role: 'user', content: message }]
        };
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 120000);
        let response;
        try {
            response = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
                signal: controller.signal
            });
            if (!response.ok) throw new Error(`Ollama chat request failed: ${response.statusText}`);
        } catch (err) {
            if (err.name === 'AbortError') {
                throw new Error('Ollama chat request timed out (2m limit).');
            }
            throw new Error(`Failed to connect to Ollama at ${url}: ${err.message}`);
        } finally {
            clearTimeout(timeout);
        }
        data = await response.json();
        if (!data.message || !data.message.content) {
            throw new Error('No image data received from Ollama chat');
        }
        data.response = data.message.content;
    } else {
        const url = `${imageTarget}/api/generate`;
        const payload = {
            model: effectiveModel,
            prompt: message,
            stream: false
        };
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 120000);
        let response;
        try {
            response = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
                signal: controller.signal
            });
            if (!response.ok) throw new Error(`Ollama generate request failed: ${response.statusText}`);
        } catch (err) {
            if (err.name === 'AbortError') {
                throw new Error('Ollama generate request timed out (2m limit).');
            }
            throw new Error(`Failed to connect to Ollama at ${url}: ${err.message}`);
        } finally {
            clearTimeout(timeout);
        }
        data = await response.json();
    }

    if (!data.response) {
        throw new Error('No image data received from Ollama');
    }

    const imageBuffer = Buffer.from(data.response, 'base64');
    const filename = `image_${Date.now()}.png`;
    const filepath = path.join(generatedDir, filename);
    await fs.writeFile(filepath, imageBuffer);

    // Save to conversation if needed (handled by caller via persistConversation)
    return {
        response: 'Image generated successfully.',
        attachments: [{ type: 'image', url: `/generated/${filename}` }],
        imageUrl: `/generated/${filename}`
    };
}

module.exports = { handleImageGeneration };
