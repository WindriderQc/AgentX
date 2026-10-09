'use strict';

/**
 * GET /api/operator-skill           what this instance would hand out
 * GET /api/operator-skill/download  the skill as a zip, ready to install
 */

const express = require('express');
const { buildOperatorSkill, archive } = require('../src/services/operatorSkill');
const { createServiceIdentity } = require('../../shared/serviceIdentity');

function createOperatorSkillRouter(options = {}) {
  const router = express.Router();
  const build = (req) => (options.build || buildOperatorSkill)({
    revision: (options.revision || (() => createServiceIdentity({ service: 'agentx-core' }).revision))(),
    origin: `${req.protocol}://${req.get('host') || 'unknown'}`,
  });
  const missing = (res) => res.status(404).json({
    ok: false, error: { code: 'OPERATOR_SKILL_UNAVAILABLE', message: 'This build does not carry the operator skill.' },
  });

  router.get('/', async (req, res, next) => {
    try {
      const skill = await build(req);
      if (!skill) return missing(res);
      return res.json({ ok: true, data: {
        name: skill.name, revision: skill.revision, generatedAt: skill.generatedAt,
        instanceSheet: skill.instanceSheet, download: `${req.baseUrl}/download`,
        files: skill.files.map(({ name, bytes }) => ({ name, bytes })),
      } });
    } catch (error) { return next(error); }
  });

  router.get('/download', async (req, res, next) => {
    try {
      const skill = await build(req);
      if (!skill) return missing(res);
      const body = archive(skill, new Date(skill.generatedAt));
      const tag = /^[0-9a-f]{7,40}$/.test(skill.revision) ? skill.revision.slice(0, 8) : 'unknown';
      res.set({
        'Content-Type': 'application/zip', 'Content-Length': String(body.length), 'Cache-Control': 'no-store',
        'Content-Disposition': `attachment; filename="${skill.name}-skill-${tag}.zip"`,
      });
      return res.end(body);
    } catch (error) { return next(error); }
  });

  return router;
}

function mount(app) {
  app.use('/api/operator-skill', createOperatorSkillRouter());
}

module.exports = { createOperatorSkillRouter, mount };
