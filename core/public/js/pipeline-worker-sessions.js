(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PipelineWorkerSessions = factory();
})(typeof window === 'undefined' ? globalThis : window, function () {
  'use strict';
  const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
  const viewers = new WeakMap();
  function identity(run) {
    return run?.harness === 'opencode' && /^\d{4}$/.test(run.pipelineId || '') && UUID.test(run.requestId || '')
      && /^[a-z][a-z0-9_-]{0,63}$/.test(run.executorId || '')
      ? { pipelineId: run.pipelineId, requestId: run.requestId, executorId: run.executorId } : null;
  }
  function safeUrl(value) {
    try {
      const url = new URL(value);
      return !url.username && !url.password && (url.protocol === 'https:'
        || url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) ? url.href : null;
    } catch { return null; }
  }

  class Viewer {
    constructor($, options = {}) {
      this.$ = $;
      this.dialog = $('pipelineNativeSessionDialog');
      this.fetch = options.fetch || globalThis.fetch.bind(globalThis);
      this.storage = options.storage || globalThis.localStorage;
      this.uuid = options.uuid || (() => globalThis.crypto.randomUUID());
      this.timer = null;
      this.generation = 0;
      $('pipelineNativeSessionClose').onclick = () => this.dialog.close();
      this.dialog.addEventListener('close', () => { this.generation++; clearTimeout(this.timer); });
      $('pipelineNativeSessionSelect').onchange = () => {
        this.generation++; this.page = null;
        $('pipelineNativeSessionMessages').replaceChildren();
        $('pipelineNativeSessionOpen').hidden = true;
        $('pipelineNativeSessionHandoff').disabled = true;
        this.status('Lecture de cette invocation…'); this.refresh(this.generation);
      };
      $('pipelineNativeSessionMore').onclick = () => this.more();
      $('pipelineNativeSessionHandoff').onclick = () => this.handoff();
    }
    path(invocation) {
      return `/api/runtime-bridges/coding-dispatch/runs/${this.run.requestId}/sessions${invocation ? `/${invocation}` : ''}`;
    }
    query(extra = {}) {
      return new URLSearchParams({ pipelineId: this.run.pipelineId, executorId: this.run.executorId, ...extra }).toString();
    }
    async request(path, options = {}) {
      const response = await this.fetch(path, { cache: 'no-store', ...options });
      const body = await response.json();
      if (!response.ok || body.status !== 'success') throw new Error(body.message || 'Lecture native indisponible');
      if (body.data.pipelineId !== this.run.pipelineId || body.data.requestId !== this.run.requestId
          || body.data.executorId !== this.run.executorId) throw new Error('La réponse ne correspond pas à cette demande.');
      return body.data;
    }
    status(text) { this.$('pipelineNativeSessionStatus').textContent = text; }
    async open(run) {
      const selected = identity(run);
      if (!selected) return;
      clearTimeout(this.timer);
      this.run = selected; this.page = null; this.generation++;
      this.$('pipelineNativeSessionMessages').replaceChildren();
      this.$('pipelineNativeSessionOpen').hidden = true;
      this.$('pipelineNativeSessionHandoff').disabled = true;
      this.$('pipelineNativeSessionMore').hidden = true;
      this.$('pipelineNativeSessionTitle').textContent = `Conversation OpenCode · tâche ${this.run.pipelineId}`;
      if (!this.dialog.open) this.dialog.showModal();
      this.status('Lecture du journal natif du worker…');
      const generation = this.generation;
      try {
        const data = await this.request(this.path() + '?' + this.query());
        if (generation !== this.generation) return;
        const select = this.$('pipelineNativeSessionSelect');
        select.replaceChildren();
        for (const session of data.sessions.slice().sort((a, b) => b.createdAt - a.createdAt)) {
          if (!UUID.test(session.invocationId || '')) continue;
          const option = select.ownerDocument.createElement('option');
          option.value = session.invocationId;
          option.textContent = `${session.nativeSessionId || 'Session en démarrage'} · ${session.state}`;
          select.append(option);
        }
        if (!select.options.length) {
          this.status('Aucun historique OpenCode lié à cette demande pour le moment.');
          this.timer = setTimeout(() => { if (generation === this.generation && this.dialog.open) this.open(run); }, 2000);
          return;
        }
        await this.refresh(generation);
      } catch (error) { if (generation === this.generation) this.status(error.message); }
    }
    async refresh(generation) {
      clearTimeout(this.timer);
      const invocation = this.$('pipelineNativeSessionSelect').value;
      if (!invocation || !this.dialog.open || generation !== this.generation) return;
      try {
        const page = await this.request(this.path(invocation) + '?' + this.query());
        if (generation !== this.generation || !this.dialog.open) return;
        if (page.invocationId !== invocation) throw new Error('Invocation native différente.');
        if (this.page?.revision !== page.revision || this.page?.invocationId !== invocation) {
          this.$('pipelineNativeSessionMessages').replaceChildren();
          this.append(page.messages); this.page = page;
        } else {
          // Local child exit can change handoff availability without adding a
          // native message. Keep the already loaded page cursor, refresh state.
          this.page = { ...page, nextOffset: this.page.nextOffset };
        }
        this.$('pipelineNativeSessionMore').hidden = this.page.nextOffset === null;
        this.$('pipelineNativeSessionHandoff').disabled = !page.canHandoff || this.copying;
        this.status(`${page.totalMessages} message(s) natifs · ${page.state === 'running' ? 'worker en cours'
          : page.state === 'exited' ? 'invocation terminée' : 'état incertain'} · actualisé à ${new Date().toLocaleTimeString()}`
          + (page.handoffConfigured === false ? ' · espace humain OpenCode non configuré' : ''));
      } catch (error) {
        if (generation === this.generation) {
          this.$('pipelineNativeSessionHandoff').disabled = true;
          this.status(`Actualisation indisponible : ${error.message}. La dernière lecture est conservée.`);
        }
      } finally {
        if (generation === this.generation && this.dialog.open) this.timer = setTimeout(() => this.refresh(generation), 2000);
      }
    }
    append(messages) {
      const container = this.$('pipelineNativeSessionMessages');
      const document = container.ownerDocument;
      for (const message of messages) {
        const article = document.createElement('article');
        const heading = document.createElement('strong');
        heading.textContent = message.info.role; article.append(heading);
        for (const part of message.parts) {
          if (part.type === 'text' || part.type === 'reasoning') {
            const pre = document.createElement('pre'); pre.textContent = part.text || ''; article.append(pre);
          } else {
            const details = document.createElement('details');
            const title = document.createElement('summary');
            title.textContent = part.type === 'tool' ? `${part.tool} · ${part.state?.status || 'inconnu'}` : part.type;
            const pre = document.createElement('pre');
            pre.textContent = JSON.stringify(part.type === 'tool'
              ? { arguments: part.state?.input, output: part.state?.output, error: part.state?.error }
              : part, null, 2);
            details.append(title, pre); article.append(details);
          }
        }
        container.append(article);
      }
    }
    async more() {
      if (this.page?.nextOffset === null || !this.page) return;
      const generation = this.generation;
      const invocation = this.page.invocationId;
      this.$('pipelineNativeSessionMore').disabled = true;
      try {
        const page = await this.request(this.path(invocation) + '?' + this.query({ offset: this.page.nextOffset, revision: this.page.revision }));
        if (generation !== this.generation || !this.dialog.open) return;
        if (page.revision !== this.page.revision || page.invocationId !== invocation) throw new Error('Le journal a changé.');
        this.append(page.messages); this.page = page;
        this.$('pipelineNativeSessionMore').hidden = page.nextOffset === null;
      } catch (error) { if (generation === this.generation) { this.page = null; this.status(error.message); await this.refresh(generation); } }
      finally { this.$('pipelineNativeSessionMore').disabled = false; }
    }
    async handoff() {
      if (!this.page?.canHandoff || this.copying) return;
      const run = { ...this.run }, page = { ...this.page }, generation = this.generation;
      const storageKey = `agentx-opencode-handoff:${run.executorId}:${run.requestId}:${page.invocationId}:${page.revision}`;
      this.copying = true;
      this.$('pipelineNativeSessionHandoff').disabled = true;
      try {
        let requestId = this.storage.getItem(storageKey);
        if (!requestId) { requestId = this.uuid(); this.storage.setItem(storageKey, requestId); }
        if (!UUID.test(requestId)) throw new Error('La demande de reprise conservée est invalide.');
        this.status('Préparation de la copie indépendante…');
        const receipt = await this.request(this.path(page.invocationId) + '/handoff', { method: 'POST',
          headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pipelineId: run.pipelineId,
            executorId: run.executorId, revision: page.revision, handoffRequestId: requestId, confirm: true }) });
        if (generation !== this.generation || !this.dialog.open) return;
        const url = safeUrl(receipt.url);
        if (receipt.state !== 'ready' || receipt.handoffRequestId !== requestId || !url) throw new Error('La reprise native reste à réconcilier.');
        const link = this.$('pipelineNativeSessionOpen'); link.href = url; link.hidden = false;
        this.status('Copie indépendante prête. Le worker et sa demande Core restent inchangés.');
      } catch (error) {
        if (generation === this.generation) this.status(`${error.message} Réessayez cette même reprise; son identité est conservée.`);
      } finally { this.copying = false; }
    }
  }

  function render({ $, run }) {
    const button = $('pipelineNativeSessionButton');
    if (!button) return;
    button.hidden = !identity(run);
    button.onclick = () => {
      const dialog = $('pipelineNativeSessionDialog');
      let viewer = viewers.get(dialog);
      if (!viewer) { viewer = new Viewer($); viewers.set(dialog, viewer); }
      return viewer.open(run);
    };
  }
  return { Viewer, identity, safeUrl, render };
});
