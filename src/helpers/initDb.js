const UserProfile = require('../../models/UserProfile');
const Workspace = require('../../models/Workspace');
const PromptConfig = require('../../models/PromptConfig');
const {
    SBQC_OPS_PERSONA,
    DATALAKE_JANITOR_PERSONA,
    DEFAULT_CHAT_PERSONA,
    SPECIALX_CONSOLE_PERSONA
} = require('../../scripts/seed-sbqc-ops');
const logger = require('../../config/logger');

async function seedDefaultData() {
    try {
        let user = await UserProfile.findOne({ userId: 'default_admin' });
        if (!user) {
            user = await UserProfile.create({
                userId: 'default_admin',
                username: 'Admin',
                email: 'admin@example.com',
                preferences: { theme: 'dark' }
            });
            logger.info('Seeded default admin user');
        }

        let workspace = await Workspace.findOne({ slug: 'default' });
        if (!workspace) {
            workspace = await Workspace.create({
                name: 'Default Workspace',
                slug: 'default',
                ownerId: user._id,
                status: 'active',
                settings: { features: { rag: true, analytics: true } }
            });
            logger.info('Seeded default workspace');
        }

        const personas = [
            SBQC_OPS_PERSONA,
            DATALAKE_JANITOR_PERSONA,
            DEFAULT_CHAT_PERSONA,
            SPECIALX_CONSOLE_PERSONA
        ];
        for (const p of personas) {
            if (!p) continue;
            const existing = await PromptConfig.findOne({ name: p.name });
            if (!existing) {
                await PromptConfig.create(p);
                logger.info('Seeded persona: ' + p.name);
            }
        }
    } catch (error) {
        logger.error('Seeding failed', { error: error.message });
    }
}
module.exports = seedDefaultData;
