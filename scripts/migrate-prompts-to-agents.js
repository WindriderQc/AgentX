#!/usr/bin/env node
/**
 * Migration Script: Convert existing PromptConfigs to AgentX entities
 *
 * This script creates "Draft Agents" from existing prompts:
 * - Links to the existing PromptConfig (preserving A/B testing)
 * - Sets a default model
 * - No N8N tools (can be added later)
 *
 * Usage:
 *   node scripts/migrate-prompts-to-agents.js [options]
 *
 * Options:
 *   --dry-run       Show what would be created without actually creating
 *   --model <name>  Default model for new agents (default: llama3.2:latest)
 *   --force         Overwrite existing agents
 */

require('dotenv').config();
const mongoose = require('mongoose');
const PromptConfig = require('../models/PromptConfig');
const AgentX = require('../models/AgentX');

// Parse command line arguments
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const force = args.includes('--force');
const modelIndex = args.indexOf('--model');
const defaultModel = modelIndex !== -1 ? args[modelIndex + 1] : 'llama3.2:latest';

// Category inference based on prompt name
const inferCategory = (name, description = '') => {
    const lower = (name + ' ' + description).toLowerCase();

    if (/code|program|develop|debug|script/.test(lower)) return 'coding';
    if (/reason|think|logic|analyz/.test(lower)) return 'reasoning';
    if (/fact|knowledge|info|wiki/.test(lower)) return 'factual';
    if (/math|calcul|number|equation/.test(lower)) return 'math';
    if (/creat|write|story|poem|art/.test(lower)) return 'creative';
    if (/workflow|n8n|automat|architect/.test(lower)) return 'specialist';

    return 'general';
};

// Avatar inference based on category and name
const inferAvatar = (category, name) => {
    const avatars = {
        coding: 'fa-code',
        reasoning: 'fa-brain',
        factual: 'fa-book',
        math: 'fa-calculator',
        creative: 'fa-palette',
        specialist: 'fa-star',
        general: 'fa-robot'
    };

    // Special cases based on name
    if (/workflow|n8n/.test(name.toLowerCase())) return 'fa-project-diagram';
    if (/chat|assistant/.test(name.toLowerCase())) return 'fa-comments';
    if (/support|help/.test(name.toLowerCase())) return 'fa-life-ring';

    return avatars[category] || 'fa-robot';
};

// Format display name from snake_case
const formatDisplayName = (name) => {
    return name
        .replace(/_/g, ' ')
        .replace(/\b\w/g, c => c.toUpperCase());
};

async function migrate() {
    console.log('\n╔════════════════════════════════════════════════════════╗');
    console.log('║       AgentX Migration: Prompts to Agents              ║');
    console.log('╚════════════════════════════════════════════════════════╝\n');

    console.log(`Options:`);
    console.log(`  - Dry Run: ${dryRun ? 'Yes (no changes will be made)' : 'No'}`);
    console.log(`  - Default Model: ${defaultModel}`);
    console.log(`  - Force Overwrite: ${force ? 'Yes' : 'No'}`);
    console.log('');

    // Connect to MongoDB
    const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/agentx';
    console.log(`Connecting to MongoDB: ${MONGODB_URI.replace(/\/\/[^:]+:[^@]+@/, '//***:***@')}`);

    await mongoose.connect(MONGODB_URI);
    console.log('✓ Connected to MongoDB\n');

    // Get unique prompt names (latest version of each)
    console.log('Fetching prompts...');
    const prompts = await PromptConfig.aggregate([
        { $sort: { version: -1 } },
        {
            $group: {
                _id: { name: '$name', workspaceId: '$workspaceId' },
                latestPrompt: { $first: '$$ROOT' }
            }
        }
    ]);

    console.log(`Found ${prompts.length} unique prompt(s)\n`);

    const results = {
        total: prompts.length,
        created: 0,
        skipped: 0,
        updated: 0,
        errors: []
    };

    for (const { latestPrompt } of prompts) {
        const promptName = latestPrompt.name;
        const workspaceId = latestPrompt.workspaceId || null;

        console.log(`Processing: ${promptName}`);

        try {
            // Check if agent already exists
            const existing = await AgentX.findOne({
                name: promptName,
                workspaceId: workspaceId
            });

            if (existing && !force) {
                console.log(`  ⊘ Skipped (agent already exists)`);
                results.skipped++;
                continue;
            }

            // Infer category and avatar
            const category = inferCategory(promptName, latestPrompt.description);
            const avatar = inferAvatar(category, promptName);
            const displayName = formatDisplayName(promptName);

            const agentData = {
                name: promptName,
                displayName: displayName,
                description: latestPrompt.description || '',
                avatar: avatar,
                category: category,
                promptConfigId: latestPrompt._id,
                defaultModel: defaultModel,
                fallbackModels: [],
                n8nTools: [],
                capabilities: {
                    supportsRag: true,
                    supportsStreaming: true
                },
                workspaceId: workspaceId,
                isActive: true,
                isDefault: promptName === 'default_chat'
            };

            if (dryRun) {
                console.log(`  → Would create agent:`);
                console.log(`    Name: ${agentData.displayName}`);
                console.log(`    Category: ${agentData.category}`);
                console.log(`    Avatar: ${agentData.avatar}`);
                console.log(`    Model: ${agentData.defaultModel}`);
                console.log(`    Default: ${agentData.isDefault}`);
                results.created++;
            } else if (existing && force) {
                // Update existing
                Object.assign(existing, agentData);
                await existing.save();
                console.log(`  ✓ Updated agent: ${agentData.displayName}`);
                results.updated++;
            } else {
                // Create new
                const agent = new AgentX(agentData);
                await agent.save();
                console.log(`  ✓ Created agent: ${agentData.displayName}`);
                results.created++;
            }
        } catch (err) {
            console.log(`  ✗ Error: ${err.message}`);
            results.errors.push({ name: promptName, error: err.message });
        }
    }

    // Summary
    console.log('\n════════════════════════════════════════════════════════');
    console.log('Migration Summary:');
    console.log(`  Total Prompts: ${results.total}`);
    console.log(`  Created: ${results.created}`);
    console.log(`  Updated: ${results.updated}`);
    console.log(`  Skipped: ${results.skipped}`);
    console.log(`  Errors: ${results.errors.length}`);

    if (results.errors.length > 0) {
        console.log('\nErrors:');
        results.errors.forEach(err => {
            console.log(`  - ${err.name}: ${err.error}`);
        });
    }

    if (dryRun) {
        console.log('\n⚠ This was a dry run. No changes were made.');
        console.log('  Run without --dry-run to perform the actual migration.');
    }

    console.log('════════════════════════════════════════════════════════\n');

    await mongoose.disconnect();
    console.log('Disconnected from MongoDB');
}

// Run migration
migrate()
    .then(() => process.exit(0))
    .catch(err => {
        console.error('Migration failed:', err);
        process.exit(1);
    });
