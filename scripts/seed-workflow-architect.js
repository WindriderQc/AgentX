#!/usr/bin/env node
/**
 * Seed script for SBQC Workflow Architect (N6.1) persona
 *
 * Usage:
 *   node scripts/seed-workflow-architect.js
 *
 * Or via npm:
 *   npm run seed:workflow-architect
 */

require('dotenv').config();
const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');
const PromptConfig = require('../models/PromptConfig');

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/agentx';
const PERSONA_FILE = path.join(__dirname, '../personas/sbqc_workflow_architect.json');

async function seedWorkflowArchitect() {
    console.log('🏗️  SBQC Workflow Architect (N6.1) Seeding Script');
    console.log('─'.repeat(60));

    try {
        // Load persona from JSON file
        console.log(`📄 Loading persona from: ${PERSONA_FILE}`);

        if (!fs.existsSync(PERSONA_FILE)) {
            throw new Error(`Persona file not found: ${PERSONA_FILE}`);
        }

        const personaData = JSON.parse(fs.readFileSync(PERSONA_FILE, 'utf8'));
        console.log(`✓ Loaded persona: ${personaData.name}\n`);

        // Connect to MongoDB
        console.log(`📡 Connecting to MongoDB: ${MONGODB_URI}`);
        await mongoose.connect(MONGODB_URI);
        console.log('✓ Connected to MongoDB\n');

        // Check if persona exists
        console.log(`📋 Checking for existing ${personaData.name} persona...`);
        const existing = await PromptConfig.findOne({ name: personaData.name });

        if (existing) {
            console.log(`   Found existing ${personaData.name} (version ${existing.version})`);
            console.log('   Updating to latest version...');

            existing.systemPrompt = personaData.systemPrompt;
            existing.description = personaData.description;
            existing.isActive = personaData.isActive;
            existing.trafficWeight = personaData.trafficWeight;
            existing.version = existing.version + 1;
            await existing.save();

            console.log(`✓ Updated ${personaData.name} to version ${existing.version}\n`);
        } else {
            await PromptConfig.create(personaData);
            console.log(`✓ Created ${personaData.name} persona (version ${personaData.version})\n`);
        }

        // Display persona info
        const savedPersona = await PromptConfig.findOne({ name: personaData.name });
        console.log('📊 Persona Details:');
        console.log('─'.repeat(60));
        console.log(`Name:        ${savedPersona.name}`);
        console.log(`Version:     ${savedPersona.version}`);
        console.log(`Active:      ${savedPersona.isActive ? 'Yes' : 'No'}`);
        console.log(`Description: ${savedPersona.description}`);
        console.log(`System Prompt Length: ${savedPersona.systemPrompt.length} characters`);
        console.log(`Traffic Weight: ${savedPersona.trafficWeight}%`);

        console.log('\n✅ Seeding complete!');
        console.log('\n📝 Test the persona with:');
        console.log('  curl -X POST http://localhost:3080/api/chat \\');
        console.log('    -H "Content-Type: application/json" \\');
        console.log('    -d \'{"message": "Create a workflow that monitors MongoDB disk usage", "options": {"persona": "sbqc_workflow_architect"}}\'');

        console.log('\n🔗 Or use the AgentX chat interface:');
        console.log('  1. Open http://localhost:3080');
        console.log('  2. Select "sbqc_workflow_architect" from the persona dropdown');
        console.log('  3. Ask: "Generate a workflow that checks DataAPI health every 10 minutes"');

    } catch (error) {
        console.error('❌ Seeding failed:', error.message);
        if (error.stack) {
            console.error('\nStack trace:');
            console.error(error.stack);
        }
        process.exit(1);
    } finally {
        await mongoose.disconnect();
        console.log('\n📡 Disconnected from MongoDB');
    }
}

// Run if called directly
if (require.main === module) {
    seedWorkflowArchitect()
        .then(() => process.exit(0))
        .catch(err => {
            console.error(err);
            process.exit(1);
        });
}

module.exports = { seedWorkflowArchitect };
