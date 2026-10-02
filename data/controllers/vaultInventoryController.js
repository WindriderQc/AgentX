const { buildVaultInventory } = require('../services/vaultInventoryService');

async function getVaultInventory(_req, res, next) {
  try {
    const inventory = await buildVaultInventory();
    res.json({ status: 'success', data: inventory });
  } catch (error) {
    if (error.code === 'VAULT_UNAVAILABLE') {
      return res.status(503).json({ status: 'error', message: error.message, code: error.code });
    }
    if (error.code === 'VAULT_INVALID_ROOT' || error.code === 'VAULT_ROOT_REALPATH_MISMATCH') {
      return res.status(409).json({ status: 'error', message: error.message, code: error.code });
    }
    return next(error);
  }
}

module.exports = { getVaultInventory };
