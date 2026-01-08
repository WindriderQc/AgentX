#!/usr/bin/env node

/**
 * Seed Prompt Templates
 * Seeds 15 system templates across 4 categories
 * Run: node scripts/seed-prompt-templates.js
 */

require('dotenv').config();
const mongoose = require('mongoose');
const PromptTemplate = require('../models/PromptTemplate');
const logger = require('../config/logger');

// System templates organized by category
const SYSTEM_TEMPLATES = [
  // CODE CATEGORY (4 templates)
  {
    name: 'Debug Code',
    category: 'code',
    description: 'Debug code with detailed error analysis',
    tags: ['debugging', 'code', 'error-analysis'],
    template: `I need help debugging this code:

{{code}}

The error message is:
{{errorMessage}}

Please:
1. Identify the root cause of the error
2. Explain why it's happening
3. Provide a corrected version of the code
4. Suggest how to prevent similar errors in the future`
  },
  {
    name: 'Code Review',
    category: 'code',
    description: 'Request comprehensive code review',
    tags: ['code-review', 'best-practices', 'optimization'],
    template: `Please review this code and provide feedback:

{{code}}

Focus areas:
- Code quality and readability
- Performance optimization opportunities
- Security considerations
- Best practices adherence
- Potential bugs or edge cases

Provide specific suggestions for improvement.`
  },
  {
    name: 'Refactor Code',
    category: 'code',
    description: 'Refactor code for better quality',
    tags: ['refactoring', 'code-quality', 'clean-code'],
    template: `Please refactor this code to improve:

{{code}}

Goals:
- Improve readability and maintainability
- Follow {{language}} best practices
- Enhance performance where possible
- Add appropriate comments
- Reduce complexity

Explain the changes you make and why.`
  },
  {
    name: 'Explain Code',
    category: 'code',
    description: 'Explain how code works',
    tags: ['explanation', 'learning', 'documentation'],
    template: `Please explain how this code works:

{{code}}

I need:
1. Line-by-line explanation of what the code does
2. The overall purpose and algorithm
3. Any patterns or techniques used
4. Potential use cases
5. Complexity analysis (time/space)

Assume I'm at a {{skillLevel}} level.`
  },

  // WRITING CATEGORY (4 templates)
  {
    name: 'Improve Writing',
    category: 'writing',
    description: 'Enhance grammar, clarity, and style',
    tags: ['writing', 'grammar', 'style'],
    template: `Please improve this text:

{{text}}

Focus on:
- Grammar and spelling
- Clarity and conciseness
- Tone: {{tone}}
- Reading level: {{readingLevel}}

Provide both the improved version and a brief explanation of major changes.`
  },
  {
    name: 'Summarize Text',
    category: 'writing',
    description: 'Create concise summary',
    tags: ['summarization', 'brevity'],
    template: `Please summarize this text:

{{text}}

Requirements:
- Length: {{length}} (brief/medium/detailed)
- Format: {{format}} (paragraph/bullet-points/key-takeaways)
- Focus on the most important information
- Maintain accuracy

Provide a clear, concise summary.`
  },
  {
    name: 'Professional Email',
    category: 'writing',
    description: 'Compose professional email',
    tags: ['email', 'business', 'communication'],
    template: `Help me write a professional email:

Purpose: {{purpose}}
Recipient: {{recipient}}
Key points to include:
{{keyPoints}}

Tone: {{tone}}

Please draft a well-structured email with:
- Appropriate greeting
- Clear subject line suggestion
- Professional body
- Suitable closing`
  },
  {
    name: 'Creative Story',
    category: 'writing',
    description: 'Generate creative story',
    tags: ['creative', 'storytelling', 'fiction'],
    template: `Write a creative story with these elements:

Genre: {{genre}}
Setting: {{setting}}
Main character: {{character}}
Conflict/Challenge: {{conflict}}

Length: {{length}} words

Make it engaging and original!`
  },

  // ANALYSIS CATEGORY (4 templates)
  {
    name: 'Compare Options',
    category: 'analysis',
    description: 'Detailed comparison analysis',
    tags: ['comparison', 'decision-making', 'analysis'],
    template: `Help me compare these options:

Option A: {{optionA}}

Option B: {{optionB}}

Criteria to consider:
{{criteria}}

Please provide:
1. Side-by-side comparison table
2. Pros and cons for each option
3. Key differentiators
4. Recommendation based on: {{context}}
5. Decision matrix if applicable`
  },
  {
    name: 'Analyze Data',
    category: 'analysis',
    description: 'Data analysis and insights',
    tags: ['data-analysis', 'insights', 'statistics'],
    template: `Analyze this data:

{{data}}

Questions to answer:
{{questions}}

Please provide:
1. Key patterns and trends
2. Statistical insights
3. Notable outliers or anomalies
4. Actionable recommendations
5. Visualization suggestions

Context: {{context}}`
  },
  {
    name: 'SWOT Analysis',
    category: 'analysis',
    description: 'Strategic SWOT analysis',
    tags: ['strategy', 'business', 'planning'],
    template: `Conduct a SWOT analysis for:

Subject: {{subject}}

Context: {{context}}

Please analyze:
- Strengths: Internal positive factors
- Weaknesses: Internal limitations
- Opportunities: External favorable conditions
- Threats: External challenges

Provide specific, actionable insights for each category.`
  },
  {
    name: 'Root Cause Analysis',
    category: 'analysis',
    description: 'Identify root causes of problems',
    tags: ['problem-solving', 'debugging', 'diagnosis'],
    template: `Help me identify the root cause of this problem:

Problem: {{problem}}

Symptoms observed:
{{symptoms}}

Context/Background:
{{context}}

Please:
1. Use the "5 Whys" technique
2. Identify potential root causes
3. Rank causes by likelihood
4. Suggest verification methods
5. Recommend solutions for each cause`
  },

  // GENERAL CATEGORY (3 templates)
  {
    name: 'Explain Like I\'m 5',
    category: 'general',
    description: 'Simple explanation for complex topics',
    tags: ['explanation', 'learning', 'simple'],
    template: `Explain this topic in simple terms:

{{topic}}

Requirements:
- Use simple language and analogies
- Avoid technical jargon
- Include concrete examples
- Make it engaging and easy to understand
- Suitable for: {{audience}}

Help me truly understand the concept!`
  },
  {
    name: 'Brainstorm Ideas',
    category: 'general',
    description: 'Generate creative ideas',
    tags: ['brainstorming', 'creativity', 'ideation'],
    template: `Help me brainstorm ideas for:

{{challenge}}

Context: {{context}}

Please generate:
- 10+ diverse ideas
- Mix of conventional and creative approaches
- Brief explanation for each idea
- Pros and cons
- Highlight the 3 most promising ideas

Think outside the box!`
  },
  {
    name: 'Research Assistant',
    category: 'general',
    description: 'Comprehensive research help',
    tags: ['research', 'learning', 'information'],
    template: `Help me research this topic:

{{topic}}

Specific questions:
{{questions}}

Please provide:
1. Overview of the topic
2. Key facts and figures
3. Different perspectives or approaches
4. Recent developments or trends
5. Recommended resources for deeper learning
6. Summary of main takeaways

Focus area: {{focusArea}}`
  }
];

/**
 * Connect to MongoDB
 */
async function connectDB() {
  const mongoUri = process.env.MONGODB_URI;
  if (!mongoUri) {
    throw new Error('MONGODB_URI environment variable is required');
  }

  await mongoose.connect(mongoUri);
  logger.info('Connected to MongoDB');
}

/**
 * Seed templates
 */
async function seedTemplates() {
  logger.info('Starting prompt templates seeding...');

  let created = 0;
  let updated = 0;
  let skipped = 0;

  for (const templateData of SYSTEM_TEMPLATES) {
    try {
      // Extract placeholders
      const placeholderNames = PromptTemplate.extractPlaceholders(templateData.template);
      const placeholders = placeholderNames.map(name => ({
        name,
        defaultValue: '',
        description: ''
      }));

      // Check if template already exists
      const existing = await PromptTemplate.findOne({
        name: templateData.name,
        isSystem: true
      });

      if (existing) {
        // Update existing template
        existing.template = templateData.template;
        existing.category = templateData.category;
        existing.description = templateData.description;
        existing.tags = templateData.tags;
        existing.placeholders = placeholders;
        await existing.save();

        logger.info(`Updated system template: ${templateData.name}`);
        updated++;
      } else {
        // Create new template
        const newTemplate = new PromptTemplate({
          name: templateData.name,
          template: templateData.template,
          category: templateData.category,
          description: templateData.description,
          tags: templateData.tags,
          placeholders,
          isSystem: true,
          userId: null, // System templates have no owner
          workspaceId: null
        });

        await newTemplate.save();
        logger.info(`Created system template: ${templateData.name}`);
        created++;
      }
    } catch (err) {
      logger.error(`Error seeding template ${templateData.name}:`, { error: err.message });
      skipped++;
    }
  }

  logger.info('Seeding complete', {
    total: SYSTEM_TEMPLATES.length,
    created,
    updated,
    skipped
  });

  // Display category breakdown
  const stats = await PromptTemplate.getCategoryStats(null, null);
  logger.info('Template statistics:', stats);
}

/**
 * Main execution
 */
async function main() {
  try {
    await connectDB();
    await seedTemplates();

    logger.info('✓ Prompt templates seeding completed successfully!');
    process.exit(0);
  } catch (err) {
    logger.error('Seeding failed:', { error: err.message, stack: err.stack });
    process.exit(1);
  }
}

// Run if called directly
if (require.main === module) {
  main();
}

module.exports = { seedTemplates, SYSTEM_TEMPLATES };
