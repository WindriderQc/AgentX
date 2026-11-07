'use strict';
const mongoose = require('mongoose');
const Imports = require('../../models/HouseholdPlantImport');
const Plant = require('../../models/HouseholdPlant');
const plants = require('./householdPlantService');
const { plantInput, LIMITS } = require('../domains/household/plants');
const { createPlantFolder, sha256, fail } = require('./householdPlantFolder');
const identification = require('./householdPlantImportQueue');
const WC = { w: 1, j: true };
function createPlantImport({ folder = createPlantFolder(), archive = require('./imageArchive').defaultArchive(), queue = identification } = {}) {
  async function list(input) {
    const result = await folder.list(input);
    const hashes = result.entries.filter(entry => entry.sha256).map(entry => entry.sha256);
    const imported = await Imports.find({ hashes: { $in: hashes } }).select('hashes plantId imported queueId state error').lean();
    return { ...result, entries: result.entries.map(entry => {
      const prior = imported.find(row => row.hashes.includes(entry.sha256));
      return prior ? { ...entry, state: prior.imported ? 'imported' : 'incomplete', plantId: String(prior.plantId),
        identification: prior.state, error: prior.error || null } : entry;
    }) };
  }
  async function thumbnail({ name, sha256: hash }) {
    if (!/^[a-f0-9]{64}$/.test(hash || '')) throw fail('Empreinte photo requise.');
    return { data: await folder.rendition(await folder.read(name, hash), true), mimeType: 'image/jpeg' };
  }
  async function importGroup(input = {}) {
    if (!Array.isArray(input.files) || !input.files.length || input.files.length > LIMITS.photos) throw fail(`Choisissez de 1 à ${LIMITS.photos} photos pour une plante.`);
    const fields = plantInput({ nickname: input.nickname, room: input.room || null }, { create: true });
    const entries = [];
    for (const file of input.files) {
      if (!/^[a-f0-9]{64}$/.test(file?.sha256 || '')) throw fail('Empreinte photo requise.');
      if (!entries.some(entry => entry.sha256 === file.sha256)) entries.push(await folder.read(file.name, file.sha256));
    }
    const hashes = entries.map(entry => entry.sha256).sort();
    const key = sha256(Buffer.from(JSON.stringify(hashes)));
    // Validate the whole group before claiming any original: a corrupt close-up
    // must not prevent importing its otherwise valid overview in another group.
    const displays = [];
    for (const entry of entries) displays.push(await folder.rendition(entry));
    // The unique multikey index claims all original hashes in one atomic write.
    // Preallocated card identity recovers a crash between this claim and create.
    await Imports.ensureImportIndexes();
    let row;
    try {
      row = await Imports.findOneAndUpdate({ _id: key }, { $setOnInsert: { hashes, files: entries.map(({ bytes: _bytes, roomHint: _hint, ...file }) => file),
        plantId: new mongoose.Types.ObjectId(), ...fields, state: 'queued' } }, { upsert: true, new: true, writeConcern: WC }).lean();
    } catch (error) {
      if (error.code !== 11000) throw error;
      row = await Imports.findById(key).lean();
      if (!row) throw fail('Une photo appartient déjà à une autre plante. Actualisez la liste.', 409, 'PLANT_IMPORT_GROUP_CONFLICT');
    }
    if (!row.imported) {
      let plant = await Plant.findOneAndUpdate({ _id: row.plantId }, { $setOnInsert: {
        nickname: row.nickname, room: row.room, status: 'draft', __v: 0
      } }, { upsert: true, new: true, runValidators: true, writeConcern: WC }).lean();
      for (let index = 0; index < entries.length; index++) {
        const entry = entries[index];
        if (plant.status !== 'draft') throw fail('La fiche doit rester un brouillon pendant l’import.', 409);
        const receipt = await archive.store({ bytes: entry.bytes, name: entry.name, origin: 'uploaded',
          context: { surface: 'household', plantId: String(row.plantId) } });
        if (receipt) await Imports.updateOne({ _id: key, 'files.sha256': entry.sha256 }, { $set: { 'files.$.archive': receipt } }, { writeConcern: WC });
        for (let attempt = 0; attempt < 5; attempt++) {
          const current = await plants.get({ id: String(row.plantId), view: 'manage' });
          if (current.plant.status !== 'draft') throw fail('La fiche doit rester un brouillon pendant l’import.', 409);
          try {
            await plants.addPhoto({ id: String(row.plantId), expectedRevision: current.plant.revision, bytes: displays[index], mimeType: 'image/jpeg' });
            break;
          } catch (error) { if (!['PLANT_EDIT_CONFLICT', 11000].includes(error.code) || attempt === 4) throw error; }
        }
        plant = await Plant.findById(row.plantId).lean();
      }
      await Imports.updateOne({ _id: key }, { $set: { imported: true } }, { writeConcern: WC });
    }
    // Also fence direct identification when route resolution or queue enrollment
    // is unavailable. The observer replaces this stable placeholder on enrollment.
    await Plant.updateOne({ _id: row.plantId, status: 'draft', 'assistant.identify.state': { $exists: false } },
      { $set: { 'assistant.identify': { state: 'queued', queueId: `plant-import:${key}` } } }, { writeConcern: WC });
    let planningError = null;
    try { await queue.enroll(await Imports.findById(key).lean()); }
    catch (error) {
      planningError = error.code || 'PLANT_IMPORT_QUEUE_UNAVAILABLE';
      await Imports.updateOne({ _id: key }, { $set: { error: planningError } });
      await Plant.updateOne({ _id: row.plantId, 'assistant.identify.state': 'queued' },
        { $set: { 'assistant.identify.error': planningError } });
    }
    return { ...(await plants.get({ id: String(row.plantId), view: 'manage' })), duplicate: row.imported,
      identification: planningError ? 'waiting' : 'queued', planningError };
  }
  return { list, thumbnail, importGroup };
}
module.exports = { createPlantImport };
