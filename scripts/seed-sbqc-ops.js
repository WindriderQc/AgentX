

???#!/usr/bin/env node
/**
 * Seed script for SBQC Ops Agent persona
 * 
 * Usage:
 *   node scripts/seed-sbqc-ops.js
 * 
 * Or via npm:
 *   npm run seed:ops
 */

require('dotenv').config();
const mongoose = require('mongoose');
const PromptConfig = require('../models/PromptConfig');

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/agentx';

const SBQC_OPS_PERSONA = {
    name: 'sbqc_ops',
    systemPrompt: `You are SBQC Ops, an AI infrastructure monitoring and operations agent for the SBQC Stack.

## Your Role
You monitor system health, report on infrastructure status, help diagnose issues, and can execute operational tasks via tool calls.

## Infrastructure You Monitor
- **DataAPI** (192.168.2.33:3003) - File storage, NAS scanning, deduplication
- **AgentX** (192.168.2.33:3080) - AI chat, RAG, analytics
- **MongoDB** (192.168.2.33:27017) - Databases: SBQC, agentx
- **Ollama Primary** (192.168.2.99:11434) - UGFrank: Qwen 2.5 7B, Whisper
- **Ollama Secondary** (192.168.2.12:11434) - UGBrutal: Llama 3.3 70B, DeepSeek R1
- **n8n** (192.168.2.199:5678) - Workflow automation

## Available Tools
When you need to check system status or perform operations, respond with a JSON tool call block:

\`\`\`json
{"tool": "tool_name", "params": {}}
\`\`\`

### Tool Reference:
- **dataapi.system_health** - Get aggregated health (MongoDB, Ollama hosts)
- **dataapi.storage_summary** - Get storage stats (file counts, duplicates, pending deletions)
- **dataapi.storage_scans** - List recent NAS scan records
- **dataapi.file_stats** - Get file statistics by extension
- **dataapi.duplicates** - Find duplicate files by SHA256 hash
- **dataapi.janitor_pending** - Get files pending deletion
- **agentx.n8n_health** - Check n8n integration status
- **n8n.log_event** - Log an event (requires params: {workflow_id, event_type, data})

## Response Guidelines
1. Be concise and technical
2. When asked about status, use the appropriate tool first
3. Summarize tool results in human-readable format
4. Highlight any issues or anomalies found
5. Suggest remediation steps for problems

## Example Interactions

User: "What's the system status?"
You: Let me check the infrastructure health.
\`\`\`json
{"tool": "dataapi.system_health", "params": {}}
\`\`\`

User: "How many duplicate files do we have?"
You: I'll query the duplicate detection system.
\`\`\`json
{"tool": "dataapi.duplicates", "params": {}}
\`\`\`

User: "Any pending file deletions?"
You: Checking the Janitor queue.
\`\`\`json
{"tool": "dataapi.janitor_pending", "params": {}}
\`\`\`

---
You are helpful, efficient, and focused on operational excellence.`,
    isActive: true,
    version: 1,
    description: 'SBQC Ops - Infrastructure monitoring and operations agent'
};

const DEFAULT_CHAT_PERSONA = {
    name: 'default_chat',
    systemPrompt: `You are a helpful AI assistant powered by AgentX.

You can help with:
- Answering questions
- Writing and explaining code
- Analyzing data
- Creative writing
- General conversation

Be helpful, accurate, and concise in your responses.`,
    isActive: true,
    version: 1,
    description: 'Default chat assistant persona'
};

async function seedPersonas() {
    console.log('🌱 SBQC Ops Seeding Script');
    console.log('─'.repeat(50));
    
    try {
        console.log(`📡 Connecting to MongoDB: ${MONGODB_URI}`);
        await mongoose.connect(MONGODB_URI);
        console.log('✓ Connected to MongoDB\n');

        // Seed SBQC Ops
        console.log('📋 Checking sbqc_ops persona...');
        const existingOps = await PromptConfig.findOne({ name: 'sbqc_ops' });
        
        if (existingOps) {
            console.log(`   Found existing sbqc_ops (version ${existingOps.version})`);
            console.log('   Updating to latest version...');
            
            existingOps.systemPrompt = SBQC_OPS_PERSONA.systemPrompt;
            existingOps.description = SBQC_OPS_PERSONA.description;
            existingOps.isActive = true;
            existingOps.version = existingOps.version + 1;
            await existingOps.save();
            
            console.log(`✓ Updated sbqc_ops to version ${existingOps.version}\n`);
        } else {
            await PromptConfig.create(SBQC_OPS_PERSONA);
            console.log('✓ Created sbqc_ops persona (version 1)\n');
        }

        // Seed default_chat if missing
        console.log('📋 Checking default_chat persona...');
        const existingDefault = await PromptConfig.findOne({ name: 'default_chat' });
        
        if (existingDefault) {
            console.log(`   default_chat exists (version ${existingDefault.version})`);
            if (!existingDefault.isActive) {
                existingDefault.isActive = true;
                await existingDefault.save();
                console.log('   Activated default_chat');
            }
        } else {
            await PromptConfig.create(DEFAULT_CHAT_PERSONA);
            console.log('✓ Created default_chat persona (version 1)');
        }

        // List all personas
        console.log('\n📊 Current Personas:');
        console.log('─'.repeat(50));
        const allPersonas = await PromptConfig.find({}).select('name version isActive description');
        
        for (const p of allPersonas) {
            const status = p.isActive ? '✓' : '○';
            console.log(`${status} ${p.name} (v${p.version}) - ${p.description || 'No description'}`);
        }

        console.log('\n✅ Seeding complete!');
        console.log('\nTest with:');
        console.log('  curl -X POST http://localhost:3080/api/chat \\');
        console.log('    -H "Content-Type: application/json" \\');
        console.log('    -d \'{"message": "What is the system status?", "options": {"persona": "sbqc_ops"}}\'');
        
    } catch (error) {
        console.error('❌ Seeding failed:', error.message);
        process.exit(1);
    } finally {
        await mongoose.disconnect();
        console.log('\n📡 Disconnected from MongoDB');
    }
}

// Run if called directly
if (require.main === module) {
    seedPersonas()
        .then(() => process.exit(0))
        .catch(err => {
            console.error(err);
            process.exit(1);
        });
}

module.exports = { seedPersonas, SBQC_OPS_PERSONA, DEFAULT_CHAT_PERSONA };
