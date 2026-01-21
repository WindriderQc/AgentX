#!/usr/bin/env node

/**
 * Seed Config Variants
 * Loads predefined configuration presets from data/config-variants.json into MongoDB.
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const logger = require('../config/logger');
const ConfigVariant = require('../models/ConfigVariant');

const DATA_PATH = path.join(__dirname, '..', 'data', 'config-variants.json');

function normalizeNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string') {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return null;
}

function loadConfigVariants() {
  if (!fs.existsSync(DATA_PATH)) {
    logger.warn('Config variant data file missing; skipping seed.', { path: DATA_PATH });
    return [];
  }

  try {
    const raw = fs.readFileSync(DATA_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      logger.error('Config variant data is not an array.', { path: DATA_PATH });
      return [];
    }

    return parsed;
  } catch (err) {
    logger.error('Failed to load config variant data.', { error: err.message });
    return [];
  }
}

async function connectDB() {
  const mongoUri = process.env.MONGODB_URI;
  if (!mongoUri) {
    throw new Error('MONGODB_URI environment variable is required');
  }

  await mongoose.connect(mongoUri);
  logger.info('Connected to MongoDB for config variant seeding');
}

function normalizeParameters(entry = {}) {
  return {
    temperature: normalizeNumber(entry.temperature),
    top_p: normalizeNumber(entry.top_p),
    top_k: normalizeNumber(entry.top_k),
    repeat_penalty: normalizeNumber(entry.repeat_penalty),
    num_ctx: normalizeNumber(entry.num_ctx),
    num_predict: normalizeNumber(entry.num_predict)
  };
}

async function seedConfigVariants() {
  const variants = loadConfigVariants();
  if (variants.length === 0) {
    logger.warn('No config variants to seed.');
    return;
  }

  let created = 0;
  let updated = 0;
  let skipped = 0;

  for (const entry of variants) {
    if (!entry || !entry.name) {
      skipped += 1;
      continue;
    }

    const name = entry.name.trim();
    const data = {
      name,
      description: typeof entry.description === 'string' ? entry.description.trim() : '',
      use_cases: Array.isArray(entry.use_cases)
        ? Array.from(new Set(entry.use_cases.map(value => (value || '').trim()))).filter(Boolean)
        : [],
      parameters: normalizeParameters(entry.parameters),
      tags: Array.isArray(entry.tags)
        ? Array.from(new Set(entry.tags.map(tag => (tag || '').trim()))).filter(Boolean)
        : [],
      expected_characteristics: entry.expected_characteristics || {},
      isSystem: true
    };

    try {
      const existing = await ConfigVariant.findOne({ name });
      if (existing) {
        existing.description = data.description;
        existing.use_cases = data.use_cases;
        existing.parameters = data.parameters;
        existing.tags = data.tags;
        existing.expected_characteristics = data.expected_characteristics;
        existing.isSystem = true;
        await existing.save();
        updated += 1;
        logger.info('Updated config variant', { name });
      } else {
        await ConfigVariant.create(data);
        created += 1;
        logger.info('Created config variant', { name });
      }
    } catch (err) {
      logger.error('Failed to seed config variant', { name, error: err.message });
      skipped += 1;
    }
  }

  logger.info('Config variant seeding summary', {
    total: variants.length,
    created,
    updated,
    skipped
  });
}

async function main() {
  try {
    await connectDB();
    await seedConfigVariants();
  } catch (err) {
    logger.error('Config variant seeding failed', { error: err.message, stack: err.stack });
    process.exit(1);
  } finally {
    if (mongoose.connection.readyState) {
      await mongoose.connection.close();
      logger.info('MongoDB connection closed');
    }
  }

  process.exit(0);
}

if (require.main === module) {
  main();
}

module.exports = {
  seedConfigVariants
};
