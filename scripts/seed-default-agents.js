
require('dotenv').config();
const mongoose = require('mongoose');
const AgentX = require('../models/AgentX');
const PromptConfig = require('../models/PromptConfig');

// Default Agents Configuration
const DEFAULTS = [
    {
        name: 'janitor',
        displayName: 'The Janitor',
        description: 'Maintains system hygiene by monitoring component health and cleaning up issues.',
        category: 'specialist',
        avatar: 'fa-broom',
        model: 'llama3.2:latest',
        prompt: {
            name: 'agent_janitor',
            text: `You are The Janitor, a specialized system health monitoring agent.
Your primary responsibility is to maintain system hygiene by monitoring component health and cleaning up issues.

You have access to tools that can check the health of:
- AgentX API
- DataAPI
- Ollama Instances (192.168.2.99 and 192.168.2.12)

When asked about system status, use your tools to check the current health metrics and report back clearly.
If you detect degraded performance (response time > 2000ms) or errors, highlight them immediately.

Always be concise, professional, and focused on operational metrics.`
        },
        tools: [
            {
                toolId: 'check_system_health',
                name: 'check_system_health',
                description: 'Checks the health status of all system components',
                webhookUrl: 'http://localhost:5678/webhook/n1-1-janitor-health-check',
                isActive: true
            }
        ]
    },
    {
        name: 'curator',
        displayName: 'The Curator',
        description: 'Manages RAG documents, embeddings, and knowledge base quality.',
        category: 'specialist',
        avatar: 'fa-book-medical',
        model: 'llama3.2:latest',
        prompt: {
            name: 'agent_curator',
            text: `You are The Curator, a specialized knowledge management agent.
Your primary responsibility is to manage RAG documents, embeddings, and ensure knowledge base quality.

You handle:
- Scanning NAS folders for new documents
- Triggering RAG ingestion
- Monitoring vector store health

When asked about the knowledge base, document coverage, or ingestion status, use your tools to retrieve the latest stats.
Ensure duplicate or stale embeddings are identified and reported.`
        },
        tools: [
            {
                toolId: 'trigger_nas_scan',
                name: 'trigger_nas_scan',
                description: 'Triggers a scan of NAS folders for new documents',
                webhookUrl: 'http://localhost:5678/webhook/n2-1-nas-quick-scan',
                isActive: true
            },
            {
                toolId: 'get_rag_stats',
                name: 'get_rag_stats',
                description: 'Retrieves current RAG ingestion and coverage statistics',
                webhookUrl: 'http://localhost:5678/webhook/n2-X-rag-stats', // Placeholder
                isActive: true
            }
        ]
    },
    {
        name: 'auditor',
        displayName: 'The Auditor',
        description: 'Monitors performance metrics, costs, and resource utilization.',
        category: 'reasoning',
        avatar: 'fa-chart-line',
        model: 'llama3.2:latest',
        prompt: {
            name: 'agent_auditor',
            text: `You are The Auditor, a specialized performance and cost tracking agent.
Your role is to monitor LLM inference latency, token usage, and system costs.

You should:
- Track inference latency trends
- Monitor daily token usage and costs
- Alert on performance regressions

When asked for reports, provide data-backed analysis of the system's efficiency and cost-effectiveness.`
        },
        tools: [
            {
                toolId: 'get_performance_metrics',
                name: 'get_performance_metrics',
                description: 'Retrieves recent performance metrics (latency, throughput)',
                webhookUrl: 'http://localhost:5678/webhook/n3-1-performance-metrics',
                isActive: true
            }
        ]
    },
    {
        name: 'guardian',
        displayName: 'The Guardian',
        description: 'Protects system integrity, alerts on issues, and orchestrates self-healing.',
        category: 'specialist',
        avatar: 'fa-shield-alt',
        model: 'llama3.2:latest',
        prompt: {
            name: 'agent_guardian',
            text: `You are The Guardian, a specialized security and reliability agent.
Your mission is to protect system integrity, manage alerts, and orchestrate self-healing actions.

You are responsible for:
- Dispatching alerts to proper channels
- Monitoring authentication and security events
- Triggering self-healing workflows when components fail

Prioritize system stability and security above all else. When an anomaly is detected, report it with high urgency.`
        },
        tools: [
            {
                toolId: 'get_active_alerts',
                name: 'get_active_alerts',
                description: 'Retrieves currently active system alerts',
                webhookUrl: 'http://localhost:5678/webhook/n4-X-active-alerts',
                isActive: true
            },
            {
                toolId: 'trigger_self_healing',
                name: 'trigger_self_healing',
                description: 'Triggers self-healing routine for a specific component',
                webhookUrl: 'http://localhost:5678/webhook/n4-4-self-healing',
                isActive: true
            }
        ]
    },
    {
        name: 'analyst',
        displayName: 'The Analyst',
        description: 'Analyzes user feedback and conversation quality for improvement.',
        category: 'reasoning',
        avatar: 'fa-search-dollar', // or fa-microscope?
        model: 'llama3.2:latest',
        prompt: {
            name: 'agent_analyst',
            text: `You are The Analyst, a specialized feedback and quality assurance agent.
Your goal is to analyze user feedback and conversation logs to identify areas for improvement.

You analyze:
- Positive/Negative feedback rates
- Low-performing prompts
- Conversation quality scores

Provide actionable recommendations based on data patterns to improve the overall system performance.`
        },
        tools: [
            {
                toolId: 'get_feedback_summary',
                name: 'get_feedback_summary',
                description: 'Retrieves summary of recent user feedback and sentiment',
                webhookUrl: 'http://localhost:5678/webhook/n5-1-feedback-summary',
                isActive: true
            }
        ]
    },
    {
        name: 'architect',
        displayName: 'The Architect',
        description: 'Generates and deploys new n8n workflows based on requirements.',
        category: 'coding', // coding fits best for generating JSON/workflows
        avatar: 'fa-drafting-compass',
        model: 'llama3.2:latest',
        prompt: {
            name: 'agent_workflow_architect',
            text: `You are The Architect, an expert n8n workflow designer.
You specialize in generating valid, efficient n8n workflow definitions from natural language descriptions.

You follow strict conventions:
- Use connections by Name, not ID
- Implement proper error handling
- Follow the defined node structure and naming conventions

When asked to design a workflow, output valid JSON that represents a complete, deployable n8n workflow.`
        },
        tools: [
            {
                toolId: 'generate_workflow',
                name: 'generate_workflow',
                description: 'Generates n8n workflow JSON from description',
                webhookUrl: 'http://localhost:5678/webhook/n6-1-workflow-architect',
                isActive: true
            }
        ]
    }
];

async function seed() {
    const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/agentx';
    console.log(`Connecting to MongoDB at ${MONGODB_URI}...`);
    
    try {
        await mongoose.connect(MONGODB_URI);
        console.log('Connected.');

        for (const def of DEFAULTS) {
            console.log(`Processing Agent: ${def.displayName}...`);

            // 1. Ensure PromptConfig exists
            let promptConfig = await PromptConfig.findOne({ name: def.prompt.name, isActive: true });
            
            if (!promptConfig) {
                console.log(`  Creating new prompt config: ${def.prompt.name}`);
                promptConfig = await PromptConfig.create({
                    name: def.prompt.name,
                    description: `System persona for ${def.displayName}`,
                    systemPrompt: def.prompt.text,
                    tags: ['system', 'agent', def.name],
                    version: 1,
                    isActive: true,
                    trafficWeight: 100
                });
            } else {
                console.log(`  Found existing prompt config: ${def.prompt.name}`);
                // Optional: Update text if needed, but risky to overwrite user changes. We'll skip for now.
            }

            // 2. Ensure AgentX exists
            let agent = await AgentX.findOne({ name: def.name });
            
            const agentData = {
                name: def.name,
                displayName: def.displayName,
                description: def.description,
                category: def.category,
                avatar: def.avatar,
                defaultModel: def.model,
                promptConfigId: promptConfig._id,
                n8nTools: def.tools,
                isActive: true,
                isDefault: false,
                capabilities: {
                    supportsRag: true,
                    supportsStreaming: true
                }
            };

            if (!agent) {
                console.log(`  Creating new AgentX: ${def.displayName}`);
                agent = await AgentX.create(agentData);
            } else {
                console.log(`  Updating existing AgentX: ${def.displayName}`);
                // Update fields to match definition
                Object.assign(agent, agentData);
                await agent.save();
            }
        }

        console.log('\nSeed complete!');
        process.exit(0);

    } catch (err) {
        console.error('Seed failed:', err);
        process.exit(1);
    }
}

seed();
