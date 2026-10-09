'use strict';

const PipelineTask = require('../../models/PipelineTask');
const Counter = require('../../models/Counter');
const Profile = require('../../models/HouseholdProfile');
const { initialTransition } = require('./pipelineTaskTransitions');
const { commitLaneTask } = require('./pipelineLaneTaskMutationService');
const {
  cleanProfileId, familyChore, familyLaunchInput, familyProfile,
  familyProfileInput, familyRoom, familyRoutineInput, nextRoutineDue
} = require('../domains/household/family');
const { familyBirthDate } = require('../domains/household/familyBirthDate');

const OPEN_FAMILY_STATUSES = Object.freeze(['queued', 'in_progress', 'review']);
const FAMILY_PIPELINE_ASSIGNEE = 'household-family';
const text = (value, max) => String(value || '').trim().slice(0, max);
const failure = (status, code, message) => Object.assign(new Error(message), { status, code });

function profileId(value) {
  if (!text(value, 80)) throw failure(400, 'FAMILY_PROFILE_ID_REQUIRED', 'profileId is required');
  return cleanProfileId(value);
}

function taskRef(value) {
  const ref = text(value, 20);
  if (!ref) throw failure(400, 'FAMILY_CHORE_REF_REQUIRED', 'ref is required');
  return /^\d{1,4}$/.test(ref) ? ref.padStart(4, '0') : ref;
}

function feedback(by, message) {
  return { by: text(by, 120), text: text(message, 1000) };
}

function cancelTask(task, by, message) {
  return commitLaneTask(task, {
    fields: { status: 'done', assignee: FAMILY_PIPELINE_ASSIGNEE,
      familyCancelled: true, checkedInAt: null },
    feedback: feedback(by, message), kind: 'family_cancelled',
    channel: 'family_surface', declaredActor: by, reason: message,
  });
}

async function compensateLaunchTask(task) {
  let current = task;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await cancelTask(current, 'household-parent-launch', 'Launch compensation cancelled this partial starter routine.');
      return;
    } catch (error) {
      if (error.code !== 'TASK_TRANSITION_CONFLICT' || attempt === 4) throw error;
      current = await PipelineTask.findById(task._id);
      if (!current) return;
    }
  }
}

async function createTask(routine, source = 'household-parent') {
  const pipelineId = String(await Counter.next('pipelineTask')).padStart(4, '0');
  return PipelineTask.create({
    pipelineId,
    title: routine.title, spec: routine.note, service: 'family', status: 'queued',
    assignee: FAMILY_PIPELINE_ASSIGNEE, epic: 'Family Routine',
    priority: routine.priority, dueAt: routine.dueAt, profileId: routine.profileId,
    cadence: routine.cadence, stars: routine.stars, completionCount: 0,
    familyCancelled: false, source,
    ...initialTransition(pipelineId, { channel: 'family_surface', declaredActor: source })
  });
}

async function getProfile(id) {
  const profile = await Profile.findOne({ profileId: id, active: true });
  if (!profile) throw failure(404, 'FAMILY_PROFILE_NOT_FOUND', 'Active family profile not found');
  return profile;
}

async function getTask(ref, childId) {
  const query = { pipelineId: taskRef(ref), service: 'family' };
  if (childId !== undefined) query.profileId = profileId(childId);
  const task = await PipelineTask.findOne(query);
  if (!task) throw failure(404, 'FAMILY_CHORE_NOT_FOUND', 'Family chore not found');
  return task;
}

async function listProfiles() {
  const rows = await Profile.find({ active: true }).sort({ createdAt: 1 }).limit(20).lean();
  return { profiles: rows.map(familyProfile) };
}

// Adult-only: the public projection plus the parent's birth date. Child-facing
// routes use listProfiles/room, whose projection never includes it.
const adultProfile = profile => ({ ...familyProfile(profile), birthDate: profile.birthDate || null });

async function listProfileDetails() {
  const rows = await Profile.find({ active: true }).sort({ createdAt: 1 }).limit(20).lean();
  return { profiles: rows.map(adultProfile) };
}

async function setProfileBirthDate(input = {}) {
  const birthDate = familyBirthDate(input.birthDate);
  const profile = await getProfile(profileId(input.profileId));
  profile.birthDate = birthDate || undefined;
  await profile.save();
  return { profile: adultProfile(profile) };
}

async function createProfile(input = {}, createdBy = 'household-parent') {
  const value = familyProfileInput(input);
  if (await Profile.findOne({ profileId: value.profileId })) {
    throw failure(409, 'FAMILY_PROFILE_EXISTS', `Profile "${value.profileId}" already exists`);
  }
  return Profile.create({ ...value, active: true, createdBy });
}

async function addProfile(input = {}) {
  return { profile: familyProfile(await createProfile(input)) };
}

async function archiveProfile(input = {}) {
  const profile = await getProfile(profileId(input.profileId));
  profile.active = false;
  await profile.save();
  return { profile: familyProfile(profile) };
}

async function launch(input = {}) {
  const plan = familyLaunchInput(input);
  let profile = null;
  const tasks = [];
  try {
    profile = await createProfile(plan.profile, 'household-parent-launch');
    for (const routine of plan.routines) tasks.push(await createTask(routine, 'household-parent-launch'));
    return { profile: familyProfile(profile), routines: tasks.map(task => familyChore(task)) };
  } catch (error) {
    // Cancel created routines before archiving their profile. If cancellation
    // cannot complete, keep the profile visible and report the failure.
    let compensationFailure = null;
    for (const task of tasks.slice().reverse()) {
      try { await compensateLaunchTask(task); }
      catch (failure) { compensationFailure = failure; }
    }
    if (compensationFailure) {
      throw Object.assign(new Error(`Family launch failed; starter routine compensation is incomplete: ${compensationFailure.message}`),
        { status: 500, code: 'FAMILY_LAUNCH_COMPENSATION_FAILED', cause: error });
    }
    if (profile) {
      try { profile.active = false; await profile.save(); }
      catch { /* Preserve the original launch failure. */ }
    }
    throw error;
  }
}

async function room(input = {}) {
  const id = profileId(input.profileId);
  const profile = await getProfile(id);
  const tasks = await PipelineTask.find({ service: 'family', profileId: id,
    status: { $ne: 'cancelled' }, familyCancelled: { $ne: true } }).limit(100).lean();
  return { profile: familyProfile(profile), room: familyRoom(tasks) };
}

async function list(input = {}) {
  const query = { service: 'family' };
  if (input.profileId) query.profileId = cleanProfileId(input.profileId);
  if (String(input.includeClosed || '') !== 'true') query.status = { $in: OPEN_FAMILY_STATUSES };
  const rows = await PipelineTask.find(query).limit(100).lean();
  const chores = rows.map(task => familyChore(task)).sort((a, b) => String(a.id).localeCompare(String(b.id)));
  return { chores };
}

async function create(input = {}) {
  const routine = familyRoutineInput(input);
  await getProfile(routine.profileId);
  return { chore: familyChore(await createTask(routine)) };
}

async function checkIn(input = {}) {
  const childId = profileId(input.profileId);
  const task = await getTask(input.ref, childId);
  if (task.status === 'review') return { alreadyWaiting: true, chore: familyChore(task) };
  if (!['queued', 'in_progress'].includes(task.status)) {
    throw failure(409, 'FAMILY_CHORE_NOT_OPEN', 'This chore is not available for check-in');
  }
  const updated = await commitLaneTask(task, {
    fields: { status: 'review', assignee: FAMILY_PIPELINE_ASSIGNEE, checkedInAt: new Date() },
    feedback: feedback(`kid:${childId}`, 'Checked in from the tool-free Kids Room; waiting for household review.'),
    kind: 'family_check_in', channel: 'family_surface', declaredActor: 'family-child',
  });
  return { alreadyWaiting: false, chore: familyChore(updated) };
}

async function approve(input = {}) {
  const task = await getTask(input.ref);
  if (task.status === 'done') return { alreadyApproved: true, rolledOver: false, chore: familyChore(task) };
  if (task.status !== 'review') throw failure(409, 'FAMILY_CHORE_NOT_WAITING', 'Chore is not waiting for household review');
  const now = new Date();
  const nextDue = nextRoutineDue(task, now);
  const updated = await commitLaneTask(task, {
    fields: { lastCompletedAt: now, completionCount: Math.max(0, Number(task.completionCount) || 0) + 1,
      checkedInAt: null, status: nextDue ? 'queued' : 'done', assignee: FAMILY_PIPELINE_ASSIGNEE,
      ...(nextDue ? { dueAt: nextDue } : {}) },
    feedback: feedback('household-parent', nextDue ? `Approved; ${task.cadence} routine rolled forward.` : 'Approved and completed from the household review surface.'),
    kind: nextDue ? 'family_rolled_over' : 'family_approved',
    channel: 'family_surface', declaredActor: 'household-parent',
  });
  return { alreadyApproved: false, rolledOver: Boolean(nextDue), chore: familyChore(updated) };
}

async function reopen(input = {}) {
  const task = await getTask(input.ref);
  const updated = await commitLaneTask(task, {
    fields: { status: 'queued', assignee: FAMILY_PIPELINE_ASSIGNEE,
      familyCancelled: false, checkedInAt: null },
    feedback: feedback('household-parent', 'Returned to the child queue for another try.'),
    kind: 'reopened', channel: 'family_surface', declaredActor: 'household-parent',
  });
  return { chore: familyChore(updated) };
}

async function cancel(input = {}) {
  const task = await getTask(input.ref);
  return { chore: familyChore(await cancelTask(task, 'household-parent', 'Cancelled from the household review surface.')) };
}

module.exports = { listProfiles, listProfileDetails, setProfileBirthDate, addProfile, archiveProfile, launch, room, list, create, checkIn, approve, reopen, cancel };
