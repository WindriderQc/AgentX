'use strict';

const PipelineTask = require('../../models/PipelineTask');
const { buildTransition, recordTransition, transitionConflict } = require('./pipelineTaskTransitions');

// Family and personal surfaces write the same task document as Pipeline. Keep
// their status and event atomic, and reject a stale document snapshot. The
// version guard also fences same-status edits that do not advance transitionSeq.
async function commitLaneTask(task, { fields = {}, feedback = null, kind = 'operator_set',
  channel, declaredActor = null, reason = null } = {}) {
  const query = { _id: task._id, service: task.service, __v: task.__v ?? null };
  const update = { $set: fields, $inc: { __v: 1 } };
  if (feedback) update.$push = { feedback: { ...feedback, at: new Date() } };
  const to = fields.status;
  if (to && to !== task.status) {
    const event = buildTransition(task, { to, kind, channel, declaredActor, reason });
    recordTransition(query, update, task, event);
  } else {
    query.status = task.status;
    query.transitionSeq = task.transitionSeq || null;
  }
  const updated = await PipelineTask.findOneAndUpdate(query, update, { new: true, runValidators: true });
  if (!updated) throw transitionConflict();
  return updated;
}

module.exports = { commitLaneTask };
