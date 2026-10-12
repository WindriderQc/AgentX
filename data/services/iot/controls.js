'use strict';

const { createHash } = require('node:crypto');
const rules = require('../../../shared/iotControlRules');
const { isDeviceId } = require('../../../shared/iotDeviceRules');
const activity = require('../activityLog');
const PROFILES = 'iot_profiles';
const SETTINGS = 'iot_controls';
const OPERATIONS = 'iot_control_operations';
const FRESH_MS = 60000;
const defaults = id => ({ _id: id, revision: 0, profileName: null, profileRevision: 0, config: [], timers: [], restoreOnBoot: false });
const publicDoc = ({ _id, ...doc }) => ({ id: _id, ...doc });
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function createControls({ db, monitor, deviceOr404, seen, now = () => new Date() }) {
  let messages = Promise.resolve();
  const dispatching = new Set();
  const settings = db.collection(SETTINGS);
  const operations = db.collection(OPERATIONS);
  const profiles = db.collection(PROFILES);
  const event = (type, meta) => activity.record(db, { type: `iot.${type}`, message: `IoT ${type.replaceAll('_', ' ')}.`,
    severity: /(?:not_sent|uncertain|failed)$/.test(type) ? 'warning' : 'info', meta }).catch(() => null);
  async function getSettings(id) {
    await deviceOr404(id);
    await settings.updateOne({ _id: id }, { $setOnInsert: defaults(id) }, { upsert: true });
    return settings.findOne({ _id: id });
  }
  function fresh(observed) {
    const age = observed ? now() - new Date(observed.receivedAt) : NaN;
    return Number.isFinite(age) && age >= 0 && age <= FRESH_MS;
  }
  async function read(id) {
    const doc = await getSettings(id);
    const operationId = doc.inFlight || doc.lastOperation;
    const operation = operationId ? await operations.findOne({ _id: operationId }) || doc.pendingOperation : null;
    return { ...publicDoc(doc), observedFresh: Boolean(fresh(doc.observed)), operation: operation ? publicDoc(operation) : null };
  }
  async function listProfiles() { return { profiles: (await profiles.find({}).sort({ _id: 1 }).limit(100).toArray()).map(publicDoc) }; }
  async function saveProfile(name, body) {
    name = rules.profileName(name);
    const checked = rules.validateProfile(body);
    try {
      const result = await profiles.findOneAndUpdate({ _id: name, revision: checked.revision }, {
        $set: { config: checked.config, updatedAt: now() }, $inc: { revision: 1 }
      }, { upsert: checked.revision === 0, returnDocument: 'after' });
      if (!result) rules.fail('Profile changed; reload it before saving', 409);
      await event('profile_saved', { profileName: name, revision: result.revision });
      return publicDoc(result);
    } catch (error) {
      if (error.code === 11000) rules.fail('Profile already exists; reload it before saving', 409);
      throw error;
    }
  }
  async function edit(id, version, changes) {
    await getSettings(id);
    const result = await settings.findOneAndUpdate({ _id: id, revision: version, inFlight: { $exists: false } }, {
      $set: { ...changes, updatedAt: now() }, $inc: { revision: 1 }
    }, { returnDocument: 'after' });
    if (!result) rules.fail('Device settings changed or an application needs reconciliation; refresh first', 409);
    return publicDoc(result);
  }
  async function assignProfile(id, body) {
    const checked = rules.validateAssignment(body);
    const profile = checked.profileName === null ? null : await profiles.findOne({ _id: checked.profileName, revision: checked.profileRevision });
    if (checked.profileName !== null && !profile) rules.fail('Profile changed or does not exist; reload profiles first', 409);
    const result = await edit(id, checked.revision, { profileName: checked.profileName, profileRevision: profile?.revision || 0,
      config: profile?.config || [], restoreOnBoot: false });
    await event('profile_assigned', { deviceId: id, profileName: checked.profileName });
    return result;
  }
  async function saveTimer(id, io, body) {
    const { revision, ...schedule } = rules.validateTimer(body);
    if (String(schedule.io) !== io) rules.fail('GPIO in path and body differ');
    const doc = await getSettings(id);
    const timers = doc.timers.filter(row => row.io !== schedule.io).concat(schedule).sort((a, b) => a.io - b.io);
    if (timers.length > rules.MAX_PINS) rules.fail('Too many timers');
    const result = await edit(id, revision, { timers });
    await event('timer_saved', { deviceId: id, io: schedule.io, enabled: schedule.enabled });
    return result;
  }
  async function canPublish(id, doc, kind, io, target) {
    const device = await deviceOr404(id);
    const link = monitor?.status?.();
    if (!monitor?.publish || !link?.configured || !link.connected) rules.fail('MQTT is disconnected or unconfigured. Nothing was sent or queued.', 503);
    if (device.status !== 'online') rules.fail('Device is not online. Nothing was sent or queued.', 409);
    if (!fresh(doc.observed)) rules.fail('No fresh version-1 firmware state. Nothing was sent.', 409);
    if (kind === 'timer' && target.enabled) {
      const output = doc.observed.outputs.find(row => row.io === io);
      if (!output?.available) rules.fail('GPIO is not an available digital output on the device', 409);
    }
  }
  async function apply(id, kind, io, body) {
    const checked = rules.validateApply(body, kind === 'profile');
    const signature = digest({ device: id, kind, io, ...checked });
    const previous = await operations.findOne({ _id: checked.requestId });
    if (previous) {
      if (previous.signature !== signature) rules.fail('requestId was used for another request', 409);
      return publicDoc(previous); // Observation/replay only: never another publish.
    }
    const doc = await getSettings(id);
    if (doc.inFlight === checked.requestId && doc.pendingOperation) {
      if (doc.pendingOperation.signature !== signature) rules.fail('requestId was used for another request', 409);
      return publicDoc(doc.pendingOperation); // Crash before receipt insertion: still never republish.
    }
    if (checked.revision !== doc.revision) rules.fail('Device settings changed; refresh before applying', 409);
    let target, outgoing;
    if (kind === 'profile') {
      if (doc.profileName === null) rules.fail('Assign a profile first');
      target = doc.config;
      outgoing = [{ topic: `esp32/${id}/configIOs`, payload: JSON.stringify(target), retain: false }];
    } else {
      target = doc.timers.find(row => row.io === io);
      if (!target) rules.fail('Save this timer first');
      outgoing = rules.timerMessages(id, target);
    }
    await canPublish(id, doc, kind, io, target);
    const record = { _id: checked.requestId, signature, deviceId: id, kind, io, target, revision: doc.revision,
      outcome: 'dispatching', startedAt: now(), baseBootId: doc.observed.bootId, baseSerial: doc.observed.serial,
      publications: [], restoreOnBoot: checked.restoreOnBoot === true };
    const fence = await settings.updateOne({ _id: id, revision: doc.revision, inFlight: { $exists: false } }, { $set: {
      inFlight: checked.requestId, lastOperation: checked.requestId, pendingOperation: record,
      ...(kind === 'profile' && !checked.restoreOnBoot ? { restoreOnBoot: false } : {})
    } });
    if (!fence.matchedCount) rules.fail('An application needs reconciliation; refresh first', 409);
    dispatching.add(record._id);
    try {
      // The fence survives an insert/write crash; recovery must observe it, never retry blindly.
      await operations.insertOne(record);
      let outcome = 'published', error = null;
      try {
        for (const message of outgoing) {
          const sent = await monitor.publish(message);
          record.publications.push({ topic: message.topic, payload: message.payload, qos: 0, retain: false, publishedAt: sent.publishedAt });
          await operations.updateOne({ _id: record._id }, { $set: { publications: record.publications } });
        }
      } catch (failure) {
        outcome = failure.statusCode === 504 || record.publications.length ? 'uncertain' : 'not_sent';
        error = String(failure.message).slice(0, 300);
      }
      await operations.updateOne({ _id: record._id, outcome: { $ne: 'acknowledged' } }, { $set: { outcome, error, finishedAt: now() } });
      if (outcome === 'not_sent') await settings.updateOne({ _id: id, inFlight: record._id }, { $unset: { inFlight: '', pendingOperation: '' } });
      if (outcome === 'published' && kind === 'profile') await settings.updateOne({ _id: id, revision: doc.revision }, { $set: { restoreOnBoot: checked.restoreOnBoot } });
      await event(`control_${outcome}`, { deviceId: id, requestId: record._id, kind, io, error });
    } finally { dispatching.delete(record._id); }
    const latest = await settings.findOne({ _id: id });
    if (latest?.inFlight === record._id && latest.observed) await acknowledge(latest, latest.observed);
    return publicDoc(await operations.findOne({ _id: record._id }));
  }
  function matches(operation, report) {
    if (operation.kind === 'profile') return operation.target.every(pin => report.config.some(row => digest(row) === digest(pin)));
    const row = report.timers.find(timer => timer.io === operation.io);
    if (!operation.target.enabled) return !row || row.enabled === false;
    return row && ['io', 'tStart', 'tStop', 'enabled'].every(field => row[field] === operation.target[field]);
  }
  async function observe(id, report) {
    const doc = await getSettings(id);
    if (doc.observed?.bootId === report.bootId && doc.observed.serial >= report.serial) return;
    const observed = { ...report, receivedAt: now() };
    await settings.updateOne({ _id: id }, { $set: { observed } });
    await acknowledge(doc, report);
  }
  async function acknowledge(doc, report) {
    if (!doc.inFlight || dispatching.has(doc.inFlight)) return;
    const operation = await operations.findOne({ _id: doc.inFlight });
    if (!operation || (report.bootId === operation.baseBootId && report.serial <= operation.baseSerial) || !matches(operation, report)) return;
    await operations.updateOne({ _id: operation._id }, { $set: { outcome: 'acknowledged', acknowledgedAt: now() } });
    await settings.updateOne({ _id: doc._id, inFlight: operation._id }, {
      $unset: { inFlight: '', pendingOperation: '' },
      ...(operation.kind === 'profile' ? { $set: { restoreOnBoot: operation.restoreOnBoot } } : {})
    });
    await event('control_acknowledged', { deviceId: doc._id, requestId: operation._id, kind: operation.kind, io: operation.io });
  }
  async function resolve(id, requestId, body) {
    rules.object(body, ['observedSerial', 'observedBootId']);
    const doc = await getSettings(id);
    if (doc.inFlight !== requestId || !fresh(doc.observed) || body.observedSerial !== doc.observed.serial || body.observedBootId !== doc.observed.bootId) rules.fail('Reconciliation needs the latest fresh device report', 409);
    if (dispatching.has(requestId)) rules.fail('Publication is still running; wait for its original result', 409);
    const receipt = await operations.findOne({ _id: requestId });
    const operation = receipt || doc.pendingOperation;
    if (!operation || now() - new Date(operation.startedAt) < 30000 || new Date(doc.observed.receivedAt) - new Date(operation.startedAt) < 25000) rules.fail('Wait for a device report after the timer staging/publication window', 409);
    const outcome = matches(operation, doc.observed) ? 'acknowledged' : 'resolved_not_applied';
    if (!receipt) await operations.insertOne(operation);
    await operations.updateOne({ _id: requestId }, { $set: { outcome, resolvedAt: now(), resolvedBootId: doc.observed.bootId, resolvedSerial: doc.observed.serial } });
    await settings.updateOne({ _id: id, inFlight: requestId }, {
      $unset: { inFlight: '', pendingOperation: '' },
      ...(outcome === 'acknowledged' && operation.kind === 'profile' ? { $set: { restoreOnBoot: operation.restoreOnBoot } } : {})
    });
    await event('control_resolved', { deviceId: id, requestId, outcome });
    return read(id);
  }
  async function answerRequest(id) {
    const doc = await getSettings(id);
    if (!doc.restoreOnBoot || doc.profileName === null || !fresh(doc.observed) || doc.inFlight) return;
    // Once per boot, including reconnects/replayed announcements. No queued action.
    const key = digest([id, doc.observed.bootId]);
    const requestId = `${key.slice(0, 8)}-${key.slice(8, 12)}-${key.slice(12, 16)}-${key.slice(16, 20)}-${key.slice(20, 32)}`;
    await apply(id, 'profile', null, { requestId, revision: doc.revision, restoreOnBoot: true });
  }
  function handleMessage(topic, payload, packet = {}) {
    const match = /^esp32\/([^/]+)\/state$/.exec(topic);
    if (!match && topic !== 'esp32/config') return null;
    if (packet.retain === true) return '';
    let id, report;
    try {
      id = match ? match[1] : payload?.toString('utf8');
      if (!isDeviceId(id)) return 'device_name';
      if (match) report = rules.parseState(payload);
      if (!seen(id)) return 'device_limit';
    } catch { return 'control_payload'; }
    messages = messages.then(() => match ? observe(id, report) : answerRequest(id)).catch(error =>
      event('control_receive_failed', { deviceId: id, error: String(error.message).slice(0, 200) }));
    return '';
  }
  return { read, listProfiles, saveProfile, assignProfile, saveTimer,
    applyProfile: (id, body) => apply(id, 'profile', null, body),
    applyTimer: (id, io, body) => {
      const pin = rules.gpio(Number(io));
      if (String(pin) !== io) rules.fail('Invalid GPIO path');
      return apply(id, 'timer', pin, body);
    }, resolve, handleMessage,
    drain: () => messages };
}

module.exports = { createControls, PROFILES, SETTINGS, OPERATIONS, FRESH_MS };
