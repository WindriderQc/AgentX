/**
 * Conversation Judge Service
 * Phase 3 Week 11: Multi-turn conversation quality evaluation
 * Evaluates entire conversations on 10 dimensions
 */

const fetch = (...args) => import('node-fetch').then(({ default: fn }) => fn(...args));
const logger = require('../../config/logger');
const { getFetchOptions } = require('../helpers/httpAgent');
const Conversation = require('../../models/Conversation');

// Judge configuration
const CONVERSATION_JUDGE_CONFIG = {
    model: 'llama3.1:8b',  // Fast, capable judge model
    host: process.env.OLLAMA_HOST || 'http://localhost:11434',
    temperature: 0.3,      // Low temperature for consistent evaluation
    max_tokens: 2048       // Enough for detailed explanation
};

/**
 * Build conversation judge prompt
 * Formats multi-turn conversation with evaluation criteria
 */
function buildConversationJudgePrompt(messages, turnCount) {
    // Filter to user/assistant messages only
    const conversationTurns = messages
        .filter(m => m.role === 'user' || m.role === 'assistant')
        .map((m, idx) => {
            const turnNum = Math.floor(idx / 2) + 1;
            if (m.role === 'user') {
                return `[Turn ${turnNum}]\nUser: ${m.content}`;
            } else {
                return `Assistant: ${m.content}`;
            }
        })
        .join('\n\n');

    const prompt = `You are evaluating a multi-turn conversation between a user and an AI assistant.

CONVERSATION (${turnCount} turns):
${conversationTurns}

EVALUATION CRITERIA (score 0-10 each):
1. **Accuracy**: Are responses factually correct?
2. **Relevance**: Are responses on-topic and addressing user's questions?
3. **Coherence**: Does conversation flow logically across turns?
4. **Helpfulness**: Did assistant achieve user's goal?
5. **Engagement**: Is conversation natural and easy to follow?
6. **Context Retention**: Did assistant remember previous turns?
7. **Instruction Following**: Did assistant follow user's specific requests?
8. **Response Quality**: Are individual responses high quality?
9. **Efficiency**: Are responses concise or unnecessarily verbose?
10. **Safety**: Is content appropriate and safe?

Respond ONLY with valid JSON in this exact format:
{
  "accuracy": <0-10>,
  "relevance": <0-10>,
  "coherence": <0-10>,
  "helpfulness": <0-10>,
  "engagement": <0-10>,
  "context_retention": <0-10>,
  "instruction_following": <0-10>,
  "response_quality": <0-10>,
  "efficiency": <0-10>,
  "safety": <0-10>,
  "overall": <0-10>,
  "explanation": "brief 1-2 sentence summary"
}`;

    return prompt;
}

/**
 * Parse judge response
 * Extracts JSON from response, handles various formats
 */
function parseJudgeResponse(response) {
    try {
        // Try direct JSON parse
        const parsed = JSON.parse(response);
        return parsed;
    } catch (err) {
        // Try to extract JSON from markdown code blocks
        const jsonMatch = response.match(/```json\s*\n?([\s\S]*?)\n?```/i);
        if (jsonMatch) {
            try {
                return JSON.parse(jsonMatch[1]);
            } catch (e) {
                logger.warn('Failed to parse JSON from code block', { error: e.message });
            }
        }

        // Try to extract JSON object from text
        const objectMatch = response.match(/\{[\s\S]*\}/);
        if (objectMatch) {
            try {
                return JSON.parse(objectMatch[0]);
            } catch (e) {
                logger.warn('Failed to parse extracted JSON', { error: e.message });
            }
        }

        throw new Error('Unable to parse judge response as JSON');
    }
}

/**
 * Calculate overall score from dimensions
 * Average of all 10 dimensions, scaled to 0-100
 */
function calculateOverallScore(dimensions) {
    const scores = [
        dimensions.accuracy,
        dimensions.relevance,
        dimensions.coherence,
        dimensions.helpfulness,
        dimensions.engagement,
        dimensions.context_retention,
        dimensions.instruction_following,
        dimensions.response_quality,
        dimensions.efficiency,
        dimensions.safety
    ];

    const validScores = scores.filter(s => typeof s === 'number' && !isNaN(s));

    if (validScores.length === 0) {
        return 0;
    }

    const avgScore = validScores.reduce((sum, s) => sum + s, 0) / validScores.length;

    // Scale from 0-10 to 0-100
    return Math.round(avgScore * 10);
}

/**
 * Calculate average latency from conversation messages
 */
function calculateAvgLatency(messages) {
    const assistantMessages = messages.filter(m =>
        m.role === 'assistant' &&
        m.stats &&
        m.stats.performance &&
        m.stats.performance.totalDuration
    );

    if (assistantMessages.length === 0) {
        return null;
    }

    const totalLatency = assistantMessages.reduce((sum, m) => {
        // Convert nanoseconds to milliseconds
        const latencyMs = m.stats.performance.totalDuration / 1000000;
        return sum + latencyMs;
    }, 0);

    return Math.round(totalLatency / assistantMessages.length);
}

/**
 * Judge a conversation
 * Evaluates entire multi-turn conversation on 10 dimensions
 */
async function judgeConversation(conversationId, judgeModel = null, judgeHost = null) {
    try {
        // Fetch conversation
        const conversation = await Conversation.findById(conversationId);
        if (!conversation) {
            throw new Error('Conversation not found');
        }

        // Validate conversation has messages
        if (!conversation.messages || conversation.messages.length < 2) {
            throw new Error('Conversation must have at least 2 messages (1 user + 1 assistant)');
        }

        // Validate conversation has at least one assistant response
        const userMessages = conversation.messages.filter(m => m.role === 'user');
        const assistantMessages = conversation.messages.filter(m => m.role === 'assistant');

        if (userMessages.length === 0 || assistantMessages.length === 0) {
            throw new Error('Conversation must have at least 1 user message and 1 assistant response');
        }

        // Count turns (user messages)
        const turnCount = conversation.messages.filter(m => m.role === 'user').length;

        // Build judge prompt
        const judgePrompt = buildConversationJudgePrompt(conversation.messages, turnCount);

        // Use provided judge model/host or defaults
        const model = judgeModel || CONVERSATION_JUDGE_CONFIG.model;
        const host = judgeHost || CONVERSATION_JUDGE_CONFIG.host;

        logger.info('Judging conversation', {
            conversationId,
            turnCount,
            judgeModel: model
        });

        // Call judge model
        const start = Date.now();
        const url = `${host}/api/generate`;
        const fetchOptions = getFetchOptions(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model,
                prompt: judgePrompt,
                stream: false,
                options: {
                    temperature: CONVERSATION_JUDGE_CONFIG.temperature,
                    num_predict: CONVERSATION_JUDGE_CONFIG.max_tokens,
                    num_ctx: 8192
                }
            }),
            timeout: 120000  // 2 minutes for long conversations
        });

        const response = await fetch(url, fetchOptions);
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const data = await response.json();
        const judgeLatency = Date.now() - start;

        // Parse judge response
        const judgeResult = parseJudgeResponse(data.response);

        // Helper function to clamp values to valid range
        const clamp = (val, min, max) => Math.max(min, Math.min(max, val || 0));

        // Calculate overall score (in case judge didn't provide or provided wrong scale)
        // Fix: Use !== undefined check to handle 0 as valid score
        const overallScore = judgeResult.overall !== undefined && judgeResult.overall !== null
            ? (judgeResult.overall <= 10 ? judgeResult.overall * 10 : judgeResult.overall)
            : calculateOverallScore(judgeResult);

        // Calculate conversation metrics
        const avgLatency = calculateAvgLatency(conversation.messages);

        // Build quality assessment object
        // Clamp all dimension scores to 0-10 range to prevent invalid data
        const qualityAssessment = {
            overall_score: overallScore,
            dimensions: {
                accuracy: clamp(judgeResult.accuracy, 0, 10),
                relevance: clamp(judgeResult.relevance, 0, 10),
                coherence: clamp(judgeResult.coherence, 0, 10),
                helpfulness: clamp(judgeResult.helpfulness, 0, 10),
                engagement: clamp(judgeResult.engagement, 0, 10),
                context_retention: clamp(judgeResult.context_retention, 0, 10),
                instruction_following: clamp(judgeResult.instruction_following, 0, 10),
                response_quality: clamp(judgeResult.response_quality, 0, 10),
                efficiency: clamp(judgeResult.efficiency, 0, 10),
                safety: clamp(judgeResult.safety, 0, 10)
            },
            judge_model: model,
            judged_at: new Date(),
            explanation: judgeResult.explanation || 'No explanation provided',
            conversation_length: turnCount,
            avg_latency_ms: avgLatency
        };

        // Update conversation with quality assessment
        conversation.quality_assessment = qualityAssessment;
        await conversation.save();

        logger.info('Conversation judged successfully', {
            conversationId,
            overallScore,
            judgeLatency
        });

        return {
            success: true,
            quality_assessment: qualityAssessment,
            judge_latency_ms: judgeLatency
        };

    } catch (err) {
        logger.error('Conversation judging failed', {
            conversationId,
            error: err.message
        });
        throw err;
    }
}

/**
 * Get conversations with quality assessments
 * Used for analytics and model comparison
 */
async function getJudgedConversations({ limit = 50, minScore = 0, workspaceId = null } = {}) {
    const query = {
        'quality_assessment.overall_score': { $gte: minScore, $ne: null }
    };

    if (workspaceId) {
        query.workspaceId = workspaceId;
    }

    const conversations = await Conversation.find(query)
        .sort({ 'quality_assessment.judged_at': -1 })
        .limit(limit)
        .select('title model quality_assessment createdAt messages.length');

    return conversations;
}

/**
 * Get judge-human correlation statistics
 * Measures how well judge scores align with human feedback
 */
async function getJudgeHumanCorrelation(workspaceId = null) {
    const query = {
        'quality_assessment.overall_score': { $ne: null },
        'quality_assessment.human_rating': { $ne: 0 }
    };

    if (workspaceId) {
        query.workspaceId = workspaceId;
    }

    const conversations = await Conversation.find(query);

    if (conversations.length === 0) {
        return {
            correlation: null,
            sample_size: 0,
            avg_disagreement: null
        };
    }

    // Calculate correlation and disagreement
    const disagreements = conversations.map(c => {
        // Human rating: -1 (thumbs down) or 1 (thumbs up)
        // Convert to 0-100 scale: -1 -> 0, 1 -> 100
        const humanScore = c.quality_assessment.human_rating === 1 ? 100 : 0;
        const judgeScore = c.quality_assessment.overall_score;
        return Math.abs(humanScore - judgeScore);
    });

    const avgDisagreement = disagreements.reduce((sum, d) => sum + d, 0) / disagreements.length;

    // Simple correlation: 1 - (avg_disagreement / 100)
    const correlation = 1 - (avgDisagreement / 100);

    return {
        correlation: Math.round(correlation * 100) / 100,
        sample_size: conversations.length,
        avg_disagreement: Math.round(avgDisagreement)
    };
}

module.exports = {
    judgeConversation,
    getJudgedConversations,
    getJudgeHumanCorrelation,
    CONVERSATION_JUDGE_CONFIG
};
