(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('../../../shared/pipelineReportSelection'));
  else root.PipelineLaunchController = factory(root.PipelineReportSelection);
})(typeof window === 'undefined' ? globalThis : window, function (profiles) {
  'use strict';
  const STORAGE_KEY = 'agentx.pipeline.simpleWorkerRequest.v1';
  const TERMINAL = new Set(['finished', 'rejected', 'stopped']);

  class PipelineLaunchController {
    constructor({ request, onChange, refreshTasks, storage, newId = () => crypto.randomUUID() }) {
      this.request = request;
      this.onChange = onChange || (() => {});
      this.refreshTasks = refreshTasks || (() => {});
      this.storage = storage;
      this.newId = newId;
      this.control = null;
      this.error = null;
      this.reconcileError = null;
      this.pending = this.restore();
      this.lastSubmission = null;
      this.submitting = false;
      this.checking = false;
      this.version = 0;
      this.timer = null;
      this.readController = null;
      this.lastRun = '';
      this.disposed = false;
    }
    static profile(input = {}) { return profiles.normalize(input); }
    static fromForm(form) {
      if (!form) return {};
      const data = new FormData(form);
      const reportName = data.get('reportName');
      const saved = String(data.get('resumeReport') || '').split(':');
      return this.profile(reportName ? { reportName, modelCallLimit: Number(data.get('modelCallLimit')),
        ...(saved.length === 2 ? { parentRequestId: saved[0], parentSha256: saved[1] } : {}) } : {});
    }
    static currentReport(task) { return profiles.currentReport(task); }
    static profileContext(task) {
      const previous = (task?.feedback || []).slice().reverse().find(row => row.reportOutcome)?.reportOutcome;
      const saved = previous?.partial || previous;
      return [task?.reportName || previous?.reportName || '', task?.reportCheckpoint?.parentRequestId || previous?.requestId || '',
        task?.reportCheckpoint?.parentSha256 || saved?.sha256 || ''].join(':');
    }
    static profileFields(task) {
      if (!task || task.canReport === false || task.automation?.mode === 'review_only' || task.codingAutonomy || task.automationAttemptCount > 0 || task.automationAttempts?.length) return '';
      const previous = (task.feedback || []).slice().reverse().find(row => row.reportOutcome)?.reportOutcome;
      const candidateName = task.reportName || previous?.reportName;
      const name = typeof candidateName === 'string' && candidateName.length <= 120 && /^[A-Za-z0-9][A-Za-z0-9._-]*\.md$/.test(candidateName) ? candidateName : 'REVIEW.md';
      const report = Boolean(previous || task.reportName);
      const saved = previous?.partial || previous;
      let checkpoint = task.reportCheckpoint || (saved?.deliverableId ? { parentRequestId: previous.requestId, parentSha256: saved.sha256 } : null);
      try { if (checkpoint) this.profile({ reportName: name, ...checkpoint }); } catch { checkpoint = null; }
      return `<label><span>Result to produce</span><select name="reportName" data-worker-profile>
        <option value=""${report ? '' : ' selected'}>Code change</option>
        <option value="${name}"${report ? ' selected' : ''}>Private Markdown report (source read-only)</option>
      </select></label><div data-report-budget${report ? '' : ' hidden'}><label><span>Report call limit</span><select name="modelCallLimit">
        <option value="128">128 model calls</option><option value="256">256 model calls</option></select></label>
        ${checkpoint ? `<label><input type="checkbox" name="resumeReport" value="${checkpoint.parentRequestId}:${checkpoint.parentSha256}" checked> Continue the saved report at the same source revision</label>` : ''}
        <p>Time and model calls are separate limits. Save findings and pending work before either runs out.</p></div>`;
    }
    static bindProfileForms(document) {
      document.addEventListener('change', event => {
        if (event.target.matches('[data-worker-profile]')) {
          const form = event.target.closest('form');
          form.querySelector('[data-report-budget]').hidden = !event.target.value;
        }
      });
    }
    static async handoff({ pipelineId, answer = '', profile = {}, controller, fetchJson, toast }) {
    toast('info', 'Preparing this task for the team…');
    const payload = await fetchJson('/api/runtime-bridges/coding-dispatch/prepare', {
      method: 'POST', body: JSON.stringify({ pipelineId, answer, ...profile })
    });
    if (!payload?.data?.ready) {
      toast('info', payload?.data?.question || 'The team left an update on this ticket.');
      return;
    }
    await controller.refresh();
    const launching = controller.launch(pipelineId, profile);
    const submission = controller.lastSubmission;
    if (!await launching) throw new Error(controller.error || 'The task is routed to the Coding Team, but the worker is busy or admission changed. Check why this task is waiting, then try again when available.');
    if (controller.error) throw new Error(controller.error);
    const run = controller.control?.run;
    if (!submission || run?.requestId !== submission.requestId || run?.pipelineId !== pipelineId) throw new Error('The new launch has not been confirmed. Checking the saved request; nothing was resubmitted.');
    if (run?.pipelineId === pipelineId && run.phase === 'rejected') throw new Error(run.message || 'The worker refused this task. Check why it is waiting.');
    if (run?.pipelineId !== pipelineId || !['accepted', 'waiting', 'running', 'finished'].includes(run.phase)) throw new Error(run?.message || 'The launch has not been confirmed. Checking the saved request; nothing was resubmitted.');
    toast('success', `Task ${pipelineId} handed to the team.`);
    }
    restore() {
      try {
        const value = JSON.parse(this.storage?.getItem(STORAGE_KEY) || 'null');
        return value && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value.requestId) && /^\d{4}$/.test(value.pipelineId)
          && Number.isSafeInteger(value.expectedAttemptCount) && value.expectedAttemptCount >= 0 ? { requestId: value.requestId, pipelineId: value.pipelineId, expectedAttemptCount: value.expectedAttemptCount, ...PipelineLaunchController.profile(value) } : null;
      } catch { return null; }
    }
    persist() {
      try {
        if (this.pending) this.storage?.setItem(STORAGE_KEY, JSON.stringify(this.pending));
        else this.storage?.removeItem(STORAGE_KEY);
      } catch { /* Server receipts remain authoritative when local storage is unavailable. */ }
    }
    changed() { if (!this.disposed) this.onChange(); }
    canLaunch(id) {
      return !this.disposed && !this.submitting && !this.pending && !this.checking && !this.error
        && this.control?.available === true && this.control?.busy === false
        && this.control.candidates.some(item => item.pipelineId === id);
    }
    canRetry() {
      const run = this.control?.run;
      return !this.disposed && !this.submitting && !this.checking && !this.error && Boolean(this.pending)
        && run?.requestId === this.pending.requestId && (run.phase === 'not_received' || run.canRetry === true);
    }
    schedule() {
      clearTimeout(this.timer);
      if (!this.disposed && (this.pending || this.control?.busy)) {
        this.timer = setTimeout(() => this.refresh(), this.error ? 5000 : 2000);
      }
    }
    async boundedRequest(url, options = {}, controller = new AbortController()) {
      const timer = setTimeout(() => controller.abort(), 25000);
      try { return await this.request(url, { ...options, signal: controller.signal }); }
      finally { clearTimeout(timer); }
    }
    async refresh() {
      if (this.disposed) return;
      const version = ++this.version;
      this.readController?.abort();
      const controller = new AbortController();
      this.readController = controller;
      this.checking = true;
      this.changed();
      try {
        const query = this.pending ? `?requestId=${encodeURIComponent(this.pending.requestId)}` : '';
        const payload = await this.boundedRequest(`/api/runtime-bridges/coding-dispatch/status${query}`, {}, controller);
        if (version !== this.version || this.disposed) return;
        if (payload?.data?.contractVersion !== 2 || !Array.isArray(payload.data.candidates)) throw new Error('The host admission and request status are unavailable. Refresh to recover.');
        this.control = payload.data;
        this.error = null;
        const run = this.control.run;
        if (!this.pending && run?.requestId && run.pipelineId && Number.isSafeInteger(run.expectedAttemptCount)
          && ['submitting', 'uncertain', 'accepted', 'running', 'stopping', 'unknown', 'waiting'].includes(run.phase)) {
          this.pending = { requestId: run.requestId, pipelineId: run.pipelineId, expectedAttemptCount: run.expectedAttemptCount, ...PipelineLaunchController.profile(run) };
          this.persist();
        }
        if (this.pending && run?.requestId === this.pending.requestId && run.pipelineId
          && Number.isSafeInteger(run.expectedAttemptCount)) {
          if (run.pipelineId !== this.pending.pipelineId) throw new Error('This saved request belongs to a different task. Inspect its original receipt.');
          this.pending = { requestId: run.requestId, pipelineId: run.pipelineId, expectedAttemptCount: run.expectedAttemptCount, ...PipelineLaunchController.profile(run) };
          this.persist();
        }
        if (this.pending && run?.requestId === this.pending.requestId && TERMINAL.has(run.phase)) {
          this.pending = null; this.reconcileError = null;
          this.persist();
        }
        const signature = run ? [run.requestId, run.phase, run.task?.status, run.task?.automationAttemptCount].join(':') : '';
        if (signature !== this.lastRun) {
          this.lastRun = signature;
          this.refreshTasks();
        }
      } catch (error) {
        if (version !== this.version || this.disposed) return;
        this.error = controller.signal.aborted ? 'Status timed out. Refresh the same request; no retry was launched.' : error.message;
      } finally {
        if (version === this.version && !this.disposed) {
          this.checking = false;
          this.changed();
          this.schedule();
        }
      }
    }
    async launch(id, profile = {}) {
      if (!this.canLaunch(id)) return false;
      const selection = PipelineLaunchController.profile(profile);
      const candidate = this.control.candidates.find(item => item.pipelineId === id);
      this.pending = { requestId: this.newId(), pipelineId: id, expectedAttemptCount: candidate.expectedAttemptCount, ...selection };
      this.persist();
      return this.submit();
    }
    async retry() {
      if (!this.canRetry()) return false;
      return this.submit();
    }
    canCancel() {
      return !this.disposed && !this.submitting && !this.checking && !this.error && Boolean(this.pending)
        && this.control?.run?.requestId === this.pending.requestId && this.control.run.canCancel === true;
    }
    async cancel() {
      if (!this.canCancel()) return false;
      this.submitting = true;
      this.changed();
      try {
        await this.boundedRequest(`/api/runtime-bridges/coding-dispatch/runs/${this.pending.requestId}/cancel`, { method: 'POST' });
      } catch (error) { this.error = error.message; }
      finally { this.submitting = false; await this.refresh(); }
      return true;
    }
    canStop() {
      return !this.disposed && !this.submitting && !this.checking && !this.error && Boolean(this.pending)
        && this.control?.run?.requestId === this.pending.requestId
        && this.control.run.pipelineId === this.pending.pipelineId && this.control.run.canStop === true;
    }
    async stop() {
      if (!this.canStop()) return false;
      const selection = { ...this.pending };
      this.submitting = true;
      this.changed();
      try {
        await this.boundedRequest(`/api/runtime-bridges/coding-dispatch/runs/${selection.requestId}/stop`, {
          method: 'POST', body: JSON.stringify({ pipelineId: selection.pipelineId, confirm: true })
        });
      } catch (error) { this.error = `${error.message}. Checking the same stop request; nothing was relaunched.`; }
      finally { this.submitting = false; await this.refresh(); }
      return true;
    }
    canReconcile() {
      const run = this.control?.run;
      return !this.disposed && !this.submitting && !this.checking && !this.error && !this.control?.busy && Boolean(this.pending)
        && run?.requestId === this.pending.requestId && run.pipelineId === this.pending.pipelineId
        && Boolean(run.reportName) && run.phase === 'unknown' && run.canReconcile === true;
    }
    async reconcile() {
      if (!this.canReconcile()) return false;
      const selection = { ...this.pending };
      this.submitting = true; this.reconcileError = null; this.changed();
      try {
        await this.boundedRequest(`/api/runtime-bridges/coding-dispatch/runs/${selection.requestId}/reconcile`, {
          method: 'POST', body: JSON.stringify({ pipelineId: selection.pipelineId, confirm: true })
        });
      } catch (error) { this.reconcileError = `${error.message}. The original report remains fenced; nothing was relaunched.`; }
      finally { this.submitting = false; await this.refresh(); }
      return !this.reconcileError;
    }
    async submit() {
      if (this.submitting || !this.pending || this.disposed) return false;
      this.submitting = true;
      ++this.version;
      this.readController?.abort();
      this.checking = false;
      this.error = null;
      this.changed();
      const request = { ...this.pending };
      this.lastSubmission = Object.freeze({ ...request });
      // Read-only reconciliation begins immediately, independently of the POST.
      // It never creates another request, including after a lost HTTP response.
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.refresh(), 1000);
      try {
        const payload = await this.boundedRequest('/api/runtime-bridges/coding-dispatch/runs', {
          method: 'POST', body: JSON.stringify({ ...request, confirm: true })
        });
        if (!payload?.data?.run || payload.data.run.requestId !== request.requestId) throw new Error('The launch receipt was incomplete. Checking the same request.');
      } catch (error) {
        if (this.pending?.requestId === request.requestId) this.error = `${error.message || 'Launch response unavailable'}. Checking the same request; nothing was resubmitted.`;
      } finally {
        this.submitting = false;
        this.changed();
        if (!this.disposed) {
          this.refreshTasks();
          await this.refresh();
        }
      }
      return true;
    }
    dispose() {
      this.disposed = true;
      ++this.version;
      clearTimeout(this.timer);
      this.readController?.abort();
    }
  }
  return PipelineLaunchController;
});
