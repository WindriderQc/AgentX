(function (root) {
  'use strict';
  function create({ api, base, getLanguage = () => 'en', onRefresh = () => {}, storage = root.sessionStorage }) {
    let sessionId, generation = 0;
    const decisions = new Map(), drafts = new Map(), checking = new Set();
    const copy = () => getLanguage() === 'fr' ? {
      title: 'Question de Nestor', resume: 'Reprendre cet envoi', check: 'Vérifier la réponse', submit: 'Envoyer cette réponse', other: 'Autre réponse',
      help: 'Cette réponse concerne cette question seulement.', answered: 'Réponse reçue.',
      accepted: 'Réponse enregistrée, envoi non confirmé.', unknown: 'Envoi à vérifier. La réponse ne sera pas renvoyée automatiquement.',
      dispatched: 'Envoi à vérifier. La réponse ne sera pas renvoyée automatiquement.',
      mismatch: 'La question a changé. Actualise-la avant de répondre.', expired: 'Question expirée.', cancelled: 'Question annulée.',
      unavailable: 'Question indisponible. Actualise son état.', invalid: 'Réponds à chaque question avant d’envoyer.',
      storage: 'Ce navigateur ne peut pas conserver la réponse en attente. Aucune réponse envoyée.'
    } : {
      title: 'Question from Nestor', resume: 'Resume this delivery', check: 'Check this answer', submit: 'Send this answer', other: 'Other answer',
      help: 'This answer applies only to this question.', answered: 'Answer received.',
      accepted: 'Answer saved; delivery unconfirmed.', unknown: 'Delivery needs verification. This answer will not be sent again automatically.',
      dispatched: 'Delivery needs verification. This answer will not be sent again automatically.',
      mismatch: 'The question changed. Refresh it before answering.', expired: 'Question expired.', cancelled: 'Question cancelled.',
      unavailable: 'Question unavailable. Refresh its status.', invalid: 'Answer each question before sending.',
      storage: 'This browser cannot retain the pending answer. No answer was sent.'
    };
    const node = (tag, text) => { const el = document.createElement(tag); if (text) el.textContent = text; return el; };
    const key = () => `agentx.question-intents:${sessionId}`;
    function retain() {
      try { storage.setItem(key(), JSON.stringify([...decisions])); return true; } catch { return false; }
    }
    function reset(id) {
      ++generation; sessionId = id; decisions.clear(); drafts.clear(); checking.clear();
      if (!id) return;
      try {
        const saved = JSON.parse(storage.getItem(key()) || '[]');
        if (Array.isArray(saved) && saved.length <= 64) for (const [sha, ref] of saved) {
          if (/^[a-f0-9]{64}$/.test(sha) && /^[a-f0-9]{64}$/.test(ref?.workId || '')
              && /^[a-f0-9-]{36}$/.test(ref?.requestId || '')) decisions.set(sha, ref);
        }
      } catch { /* A broken local journal cannot authorize sending again. */ }
    }
    const receiptMatches = (saved, ref) => saved?.workId === ref.workId && saved.intent?.requestId === ref.requestId
      && saved.intent.resolutionId === ref.requestId;
    async function lookup(sha, ref) {
      if (checking.has(ref.requestId)) return;
      checking.add(ref.requestId); const current = generation;
      try {
        const saved = await api(`${base}/${encodeURIComponent(sessionId)}/work/${encodeURIComponent(ref.workId)}/question-intents/${encodeURIComponent(ref.requestId)}`);
        if (current !== generation) return;
        if (receiptMatches(saved, ref)) { ref.state = saved.intent.state; retain(); }
      } catch { if (current === generation) ref.state = 'unknown'; }
      finally { if (current === generation) { checking.delete(ref.requestId); onRefresh(); } }
    }
    function render(host, item, { stale = false } = {}) {
      if (!sessionId || item.sessionId !== sessionId || !item.nativeQuestions) return;
      const c = copy(), state = item.nativeQuestions;
      const section = node('section'); section.className = 'conversation-questions';
      section.append(node('h3', c.title));
      if (state.supported === false && !(state.questions || []).length) section.append(node('p', c.unavailable));
      for (const shown of state.questions || []) {
        const sha = shown.basis.questionSha256;
        let ref = decisions.get(sha);
        const received = state.intents?.find(i => i.questionSha256 === sha);
        if (received) {
          ref = { workId: item.id, requestId: received.requestId, state: received.state };
          decisions.set(sha, ref);
        }
        if (ref) {
          const status = node('p', c[ref.state] || c.unknown); section.append(status);
          if (received?.state === 'accepted' && !stale && state.supported) {
            const resume = node('button', c.resume); resume.type = 'button';
            resume.onclick = async () => {
              if (resume.disabled) return;
              resume.disabled = true; const current = generation;
              try {
                const saved = await api(`${base}/${encodeURIComponent(sessionId)}/work/${encodeURIComponent(item.id)}/question-intents/${encodeURIComponent(ref.requestId)}/resume`,
                  { method: 'POST', body: '{}' });
                if (current === generation && receiptMatches(saved, ref)) { ref.state = saved.intent.state; retain(); }
              } catch { if (current === generation) ref.state = 'unknown'; }
              if (current === generation) { status.textContent = c[ref.state] || c.unknown; onRefresh(); }
            };
            section.append(resume);
          }
          if (['dispatched', 'unknown'].includes(ref.state)) {
            const check = node('button', c.check); check.type = 'button'; check.disabled = stale;
            check.onclick = () => { check.disabled = true; void lookup(sha, ref); }; section.append(check);
          }
          if (!received && !['answered', 'mismatch', 'expired', 'cancelled'].includes(ref.state)) void lookup(sha, ref);
          continue;
        }
        const form = node('form'); form.dataset.questionFingerprint = sha;
        const values = drafts.get(sha) || Object.create(null); drafts.set(sha, values);
        const inputs = [];
        for (const q of shown.questions) {
          const field = node('fieldset'); field.append(node('legend', q.question));
          const selected = values[q.questionId] || { options: [], other: '' }; values[q.questionId] = selected;
          const options = []; let other;
          for (const option of q.options) {
            const label = node('label'), input = node('input');
            input.type = q.multiSelect ? 'checkbox' : 'radio'; input.name = `${sha}-${q.questionId}`;
            input.value = option.value ?? option.label; input.checked = selected.options.includes(input.value);
            input.disabled = stale || !state.supported || !shown.answerable;
            input.onchange = () => {
              selected.options = options.filter(el => el.checked).map(el => el.value);
              if (!q.multiSelect && input.checked && other) { other.value = ''; selected.other = ''; }
            };
            options.push(input); label.append(input, node('span', option.label));
            if (option.description) label.append(node('small', option.description));
            field.append(label);
          }
          if (q.isOther || !q.options.length) {
            const label = node('label', c.other); other = node('textarea'); other.maxLength = 4096;
            other.value = selected.other; other.disabled = stale || !state.supported || !shown.answerable;
            other.oninput = () => { selected.other = other.value;
              if (!q.multiSelect && other.value.trim()) { options.forEach(el => { el.checked = false; }); selected.options = []; } }; label.append(other); field.append(label);
          }
          inputs.push({ q, options, other }); form.append(field);
        }
        const notice = node('p', stale || !state.supported || !shown.answerable ? c.unavailable : c.help); notice.setAttribute('role', 'status');
        const submit = node('button', c.submit); submit.type = 'submit';
        submit.disabled = stale || !state.supported || !shown.answerable;
        form.append(submit, notice);
        form.onsubmit = async event => {
          event.preventDefault(); if (submit.disabled || decisions.has(sha)) return;
          const answers = {};
          for (const { q, options, other } of inputs) {
            const selected = options.filter(el => el.checked).map(el => el.value);
            if (other?.value.trim()) selected.push(other.value.trim());
            if (!selected.length || !q.multiSelect && selected.length > 1) { notice.textContent = c.invalid; return; }
            Object.defineProperty(answers, q.questionId, { value: selected, enumerable: true });
          }
          if (!root.crypto?.randomUUID || decisions.size >= 64) { notice.textContent = c.storage; return; }
          const ref = { workId: item.id, requestId: root.crypto.randomUUID(), state: 'unknown' };
          decisions.set(sha, ref);
          if (!retain()) { decisions.delete(sha); notice.textContent = c.storage; return; }
          submit.disabled = true; notice.textContent = c.unknown;
          const current = generation;
          try {
            const saved = await api(`${base}/${encodeURIComponent(sessionId)}/work/${encodeURIComponent(item.id)}/questions`, {
              method: 'POST', body: JSON.stringify({ basis: shown.basis, requestId: ref.requestId, answers: { answers } }) });
            if (current !== generation) return;
            if (receiptMatches(saved, ref)) { ref.state = saved.intent.state; retain(); }
          } catch { /* The original decision is now lookup-only, even after reload. */ }
          if (current === generation) { notice.textContent = c[ref.state] || c.unknown; onRefresh(); }
        };
        section.append(form);
      }
      for (const intent of state.intents || []) {
        if (!(state.questions || []).some(q => q.basis.questionSha256 === intent.questionSha256)) section.append(node('p', c[intent.state] || c.unknown));
      }
      if (section.children.length > 1) host.append(section);
    }
    return { render, reset };
  }
  root.NestorQuestions = { create };
  if (typeof module === 'object' && module.exports) module.exports = { create };
})(typeof globalThis === 'undefined' ? this : globalThis);
