/**
 * Dreaming Review explanatory copy: what each trust level means, where each
 * destination writes, and what each decision dialog says. Static text only.
 */
(function (root) {
  'use strict';

  const trustHelp = {
    explicit_memory_request: 'You explicitly asked an agent to remember this.',
    authenticated_owner_statement: 'This was observed in an authenticated owner turn; Core still decides whether it is fact, inference, or noise.',
    observed_project_event: 'This came from the configured accepted project history. It is event context, not a personal preference.',
    verified_runtime_evidence: 'The runtime directly verified this state.',
    verified_git_or_test_outcome: 'A repository or test result independently verified it.',
    explicit_owner_instruction: 'This came from a direct owner instruction.',
    repeated_owner_preference: 'The same owner preference appeared in independent sessions.',
    household_member_statement: 'Someone of the household said this on a family page. It is not the owner speaking and is never applied without review.',
  };
  const targetHelp = {
    shared_fact: ['Your memory notes', 'Becomes one of the notes your agents read, after this one approved write.', 'You can correct or forget it in the memory editor.'],
    soft_memory: ['AgentX working memory', 'Stores a provisional, confidence-tagged inference with expiry.', 'Rollback removes the working-memory document; recall never confirms it.'],
    artifact: ['AgentX knowledge artifact', 'Creates a concise durable artifact—never a transcript archive.', 'Rollback removes the created artifact document.'],
    pipeline_task: ['AgentX delivery pipeline', 'Creates one reviewable, unassigned follow-up task.', 'Rollback closes the task as cancelled.'],
    git_change: ['Governed source change', 'Creates a follow-up task or exact patch proposal; it does not edit git automatically.', 'No repository file is changed by this apply.'],
    skill_draft: ['Skill authoring lane', 'Creates a reviewed draft/task; it never installs a runtime skill.', 'No live skill is changed by this apply.'],
    runtime_local: ['Owning runtime', 'Produces a copyable pending proposal for the owning runtime; AgentX writes nothing there.', 'Nothing external is changed automatically.'],
    ignore: ['No destination', 'This classification is retained for audit only.', 'No semantic write is available.'],
  };

  const actionCopy = {
    approve: ['Approve this candidate?', 'It becomes eligible for a separate apply action. Nothing is written yet.', 'Approve candidate', 'fa-check', 'mr-btn-approve'],
    reject: ['Reject this candidate?', 'The normalized claim stays suppressed until materially new evidence appears.', 'Reject candidate', 'fa-xmark', 'mr-btn-reject'],
    defer: ['Defer this candidate?', 'Keep it pending so future recurrence can strengthen or clarify it.', 'Defer candidate', 'fa-clock', 'mr-btn-secondary'],
    edit_approve: ['Edit and approve', 'Refine the wording while preserving the original proposal and evidence.', 'Save & approve', 'fa-pen', 'mr-btn-approve'],
    apply: ['Apply this approved candidate?', 'AgentX will route this single change through the target owner and record the result.', 'Apply to owner', 'fa-route', 'mr-btn-apply'],
    authorize: ['Authorize reviewed writes for this run?', 'This unlocks individual apply buttons. It does not apply anything by itself.', 'Authorize run', 'fa-key', 'mr-btn-apply'],
  };

  root.MemoryReviewCopy = Object.freeze({ trustHelp, targetHelp, actionCopy });
}(window));
