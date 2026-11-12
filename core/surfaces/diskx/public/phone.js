/* Phone workbench: Core/native receipts own all state. No implicit deletion. */
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id),
    api = '/api/phone-media';
  const state = {
    devices: [],
    run: '',
    offset: 0,
    total: 0,
    items: [],
    selected: new Map(),
    cleanupEnabled: false,
    busy: false,
    pageSequence: 0,
    plan: null,
    lastJob: null,
  };
  const bytes = (n) =>
    new Intl.NumberFormat('fr-CA', { maximumFractionDigits: 1 }).format(
      n / (n >= 1e9 ? 1e9 : n >= 1e6 ? 1e6 : n >= 1e3 ? 1e3 : 1),
    ) +
    ' ' +
    (n >= 1e9 ? 'Go' : n >= 1e6 ? 'Mo' : n >= 1e3 ? 'ko' : 'octets');
  const say = (message, error = false) => {
    $('message').textContent = message;
    $('message').classList.toggle('error', error);
  };
  const messages = {
    PHONE_NOT_CONFIGURED: 'Le collecteur Android n’est pas encore configuré.',
    PHONE_UNAVAILABLE:
      'Le téléphone ou le collecteur est indisponible. Vérifie la connexion, puis reprends la même opération.',
    PHONE_BUSY: 'Un traitement du téléphone est encore actif.',
    CLEANUP_DISABLED: 'La suppression n’est pas activée sur ce collecteur.',
    CLEANUP_UNCERTAIN:
      'Le résultat USB reste incertain. Réconcilie l’opération existante; sa suppression ne sera pas répétée.',
    SOURCE_CHANGED:
      'Le fichier du téléphone a changé depuis la sauvegarde. Refais un import avant de le retirer.',
    COPY_VERIFICATION_FAILED:
      'La copie Media est absente ou a changé. La suppression de ce fichier est bloquée.',
    BACKUP_REQUIRED: 'Une copie Media vérifiée est nécessaire.',
    REVIEW_CHANGED: 'Ce tri a changé ailleurs. Actualise la vue.',
    SOURCE_CLEANUP_HELD: 'Ce fichier est déjà retiré ou appartient à une opération à réconcilier.',
    JOB_RECONCILIATION_REQUIRED: 'Le lancement initial doit être vérifié avant une reprise.',
  };
  const errorMessage = (error) => messages[error?.code] || error?.message || 'Opération indisponible.';
  function node(tag, text, cls) {
    const el = document.createElement(tag);
    if (text !== undefined) el.textContent = text;
    if (cls) el.className = cls;
    return el;
  }
  async function call(input, write = false) {
    const response = await fetch(write ? api : api + '?' + new URLSearchParams(input), {
      method: write ? 'POST' : 'GET',
      cache: 'no-store',
      redirect: 'error',
      headers: write ? { 'Content-Type': 'application/json' } : {},
      ...(write ? { body: JSON.stringify(input) } : {}),
    });
    const result = await response.json();
    if (!response.ok || !result.ok)
      throw Object.assign(new Error(result.message || 'Le collecteur est indisponible.'), {
        code: result.code,
      });
    return result.data;
  }
  function pending(value) {
    try {
      if (value === null) sessionStorage.removeItem('phone-media.pending');
      else if (value) sessionStorage.setItem('phone-media.pending', JSON.stringify(value));
      else return JSON.parse(sessionStorage.getItem('phone-media.pending') || 'null');
    } catch {
      return null;
    }
  }
  function selected() {
    const n = state.selected.size,
      total = [...state.selected.values()].reduce((a, x) => a + x.size, 0);
    $('selection-count').textContent = n
      ? `${n} fichier${n > 1 ? 's' : ''} sélectionné${n > 1 ? 's' : ''}`
      : 'Aucun fichier sélectionné';
    $('selection-bytes').textContent = n
      ? `${bytes(total)} de fichiers sélectionnés · place récupérable estimée`
      : 'Choisis uniquement les fichiers que tu veux enlever du téléphone.';
    $('prepare').disabled = !n || n > 100 || !state.cleanupEnabled || state.busy;
    $('clear').disabled = !n;
  }
  function busy() {
    state.busy = state.lastJob && ['running', 'accepted'].includes(state.lastJob.state);
    $('import').disabled = !state.devices.length || state.busy;
    selected();
  }
  function sourceDate(value) {
    try {
      if (!/^64:\d+$/.test(value)) return null;
      const date = new Date(Number(BigInt(value.slice(3)) / 10000n - 11644473600000n));
      return Number.isFinite(date.getTime()) ? date.toLocaleDateString('fr-CA') : null;
    } catch {
      return null;
    }
  }
  function renderItems() {
    const grid = $('cards');
    grid.replaceChildren();
    if (!state.items.length) grid.append(node('p', 'Aucun fichier dans cette vue.', 'empty'));
    for (const item of state.items) {
      const card = node('article', undefined, 'card'),
        picture = node('div', undefined, 'picture');
      const fallback = node(
        'span',
        item.format?.match(/mp4|mov|mkv|webm/i)
          ? '▻ Vidéo'
          : item.format?.match(/xmp|aae/i)
            ? 'Fichier associé'
            : 'Aperçu indisponible',
        'fallback',
      );
      picture.append(fallback);
      if (item.backup && !/mp4|mov|mkv|webm|xmp|aae/i.test(item.format || '')) {
        const img = node('img');
        img.loading = 'lazy';
        img.alt = item.name;
        img.src = `${api}/preview/${encodeURIComponent(state.run)}/${encodeURIComponent(item.requestId)}`;
        img.addEventListener('load', () => {
          fallback.hidden = true;
        });
        img.addEventListener('error', () => img.remove());
        picture.append(img);
      }
      card.append(picture);
      const body = node('div', undefined, 'card-body');
      body.append(node('h3', item.name), node('div', item.relativePath, 'path'));
      const facts = node('div', undefined, 'facts');
      facts.append(node('span', bytes(item.size)), node('span', (item.format || '').slice(1).toUpperCase()));
      const date = sourceDate(item.modified);
      if (date) facts.append(node('span', 'Date fichier : ' + date));
      body.append(
        facts,
        node(
          'span',
          item.backup
            ? item.backup.disposition === 'duplicate'
              ? 'Doublon reçu sur Media'
              : 'Copie reçue sur Media'
            : 'Sauvegarde en attente',
          'badge' + (item.backup ? '' : ' pending'),
        ),
      );
      const choice = node('select');
      choice.setAttribute('aria-label', 'Tri de ' + item.name);
      for (const [value, label] of [
        ['review', 'À trier'],
        ['keep', 'Garder'],
        ['archive', 'Archiver'],
      ]) {
        const option = node('option', label);
        option.value = value;
        choice.append(option);
      }
      choice.value = item.review.choice;
      choice.addEventListener('change', async () => {
        const original = item.review;
        choice.disabled = true;
        try {
          item.review = await call(
            {
              op: 'review',
              runId: state.run,
              requestId: item.requestId,
              choice: choice.value,
              writeId: crypto.randomUUID(),
              expectedRevision: original.revision,
            },
            true,
          );
        } catch (e) {
          choice.value = original.choice;
          say(errorMessage(e), true);
        } finally {
          choice.disabled = false;
        }
      });
      body.append(choice);
      const label = node('label', undefined, 'choose'),
        check = node('input');
      check.type = 'checkbox';
      check.checked = state.selected.has(item.requestId);
      check.disabled = !item.backup || item.phone === 'deleted' || item.phone === 'uncertain';
      label.append(
        check,
        node(
          'span',
          item.phone === 'deleted'
            ? 'Supprimé du téléphone'
            : item.phone === 'uncertain'
              ? 'Suppression à réconcilier'
              : 'Retirer du téléphone après vérification',
        ),
      );
      card.classList.toggle('chosen', check.checked);
      check.addEventListener('change', () => {
        if (check.checked && state.selected.size >= 100) {
          check.checked = false;
          say('Prépare un lot de 100 fichiers maximum.', true);
          return;
        }
        check.checked ? state.selected.set(item.requestId, item) : state.selected.delete(item.requestId);
        card.classList.toggle('chosen', check.checked);
        selected();
      });
      body.append(label);
      card.append(body);
      grid.append(card);
    }
    $('previous').disabled = state.offset === 0;
    $('next').disabled = state.offset + 24 >= state.total;
    $('page-count').textContent = state.total
      ? `${state.offset + 1}–${Math.min(state.offset + 24, state.total)} sur ${state.total}`
      : '';
    selected();
  }
  async function loadPage() {
    if (!state.run) return;
    const generation = ++state.pageSequence,
      run = state.run;
    const data = await call({
      op: 'page',
      runId: run,
      offset: state.offset,
      limit: 24,
      search: $('search').value,
      order: $('order').value,
    });
    if (generation !== state.pageSequence || run !== state.run) return;
    state.items = data.items;
    state.total = data.total;
    const coverage = data.coverage || {};
    $('coverage').textContent =
      (coverage.enumerationComplete === true ? 'Inventaire USB reçu. ' : 'Couverture USB partielle. ') +
      (coverage.signatureAuditComplete === false
        ? 'Certains fichiers sont vides ou n’ont pas pu être identifiés. '
        : '') +
      'Les copies reçues seront revérifiées avant toute suppression.';
    renderItems();
  }
  async function runs() {
    const data = await call({ op: 'runs' }),
      select = $('run'),
      previous = state.run;
    select.replaceChildren(node('option', 'Choisir un import'));
    select.firstChild.value = '';
    for (const run of data.runs) {
      const option = node(
        'option',
        `${new Date(run.at).toLocaleString('fr-CA')} · ${run.selected} fichiers · ${run.runId.slice(0, 8)}`,
      );
      option.value = run.runId;
      select.append(option);
    }
    if (previous && data.runs.some((x) => x.runId === previous)) select.value = previous;
    else if (data.runs.length) {
      state.run = data.runs[0].runId;
      select.value = state.run;
      state.offset = 0;
      state.selected.clear();
    }
  }
  async function status() {
    const data = await call({ op: 'status' });
    state.cleanupEnabled = data.cleanupEnabled === true;
    const previous = state.lastJob;
    state.lastJob =
      data.jobs.find((job) => ['accepted', 'running'].includes(job.state)) || data.jobs[0] || null;
    const job = state.lastJob;
    $('job').hidden = !job;
    if (job) {
      const labels = {
        accepted: 'Préparation de l’opération…',
        running:
          job.kind === 'cleanup' ? 'Suppression confirmée en cours…' : 'Import et vérification sur Media…',
        completed: 'Opération terminée',
        incomplete: 'Import à reprendre',
        failed: 'Opération arrêtée',
        unknown: 'Résultat à réconcilier · ne pas créer une autre suppression',
      };
      const selectionReceived =
        job.kind === 'import' &&
        job.state === 'incomplete' &&
        job.result?.counts?.pending === 0 &&
        job.result?.counts?.failedVerification === 0;
      $('job-title').textContent = selectionReceived
        ? 'Copies reçues · couverture partielle'
        : labels[job.state] || job.state;
      $('job-detail').textContent =
        (job.error
          ? errorMessage(job.error) +
            (job.result?.deleted
              ? ` · ${job.result.deleted} fichiers supprimés, ${bytes(job.result.confirmedBytes)} correspondants.`
              : ` · Référence : ${job.requestId}`)
          : null) ||
        (job.result?.deleted !== undefined
          ? `${job.result.deleted} fichiers supprimés · taille correspondante : ${bytes(job.result.confirmedBytes)}`
          : job.progress
            ? `${job.progress.verified} / ${job.progress.selected} fichiers reçus sur Media`
            : job.kind === 'import'
              ? 'Lecture de l’inventaire et préparation de l’import…'
              : 'Vérification des copies et préparation de la suppression…');
      const progress = $('job-progress');
      if (job.progress) {
        progress.max = job.progress.selected || 1;
        progress.value = job.progress.verified;
      } else progress.removeAttribute('value');
      $('resume').hidden = !(
        job.kind === 'import' &&
        !selectionReceived &&
        ['incomplete', 'failed', 'unknown'].includes(job.state)
      );
      $('reconcile').hidden = !(job.kind === 'cleanup' && ['failed', 'unknown'].includes(job.state));
      const waiting = pending();
      if (waiting?.requestId === job.requestId && ['completed', 'failed', 'incomplete'].includes(job.state))
        pending(null);
    }
    busy();
    if (!state.cleanupEnabled && state.selected.size)
      say('La suppression n’est pas activée sur le collecteur. Le tri et les copies restent disponibles.');
    if (
      job &&
      (!previous || job.requestId !== previous.requestId || job.state !== previous.state) &&
      (['completed', 'incomplete'].includes(job.state) ||
        (job.kind === 'cleanup' && ['failed', 'unknown'].includes(job.state)))
    ) {
      if (job.kind === 'import' && state.run !== job.runId) {
        state.run = job.runId;
        state.offset = 0;
        state.selected.clear();
        state.plan = null;
        $('confirmation').close();
      }
      if (job.kind === 'cleanup' && state.plan?.planId === job.planId) {
        state.selected.clear();
        state.plan = null;
        $('confirmation').close();
      }
      await runs();
      await loadPage();
    }
  }
  async function detect() {
    const data = await call({ op: 'devices' });
    state.devices = data.devices;
    $('device').replaceChildren();
    for (const device of data.devices) {
      const option = node('option', device.name);
      option.value = device.id;
      $('device').append(option);
    }
    $('device').hidden = data.devices.length < 2;
    $('device-state').textContent = data.devices.length
      ? data.devices.map((x) => x.name).join(' · ')
      : 'Aucun téléphone détecté. Vérifie le câble de données, le déverrouillage et le transfert de fichiers.';
    busy();
  }
  async function startImport(resume) {
    const old = pending();
    const input =
      old?.kind === 'import' && old.resume === (resume || undefined)
        ? old
        : {
            op: 'start',
            requestId: crypto.randomUUID(),
            kind: 'import',
            ...(resume ? { resume } : { deviceId: $('device').value }),
          };
    pending(input);
    await call(input, true);
    say('Import enregistré. Tu peux suivre la vérification ci-dessous.');
    await status();
  }
  $('detect').addEventListener('click', () => guard(detect));
  $('import').addEventListener('click', () => guard(() => startImport()));
  $('resume').addEventListener('click', () =>
    guard(async () => {
      await call({ op: 'reconcile', requestId: state.lastJob.requestId }, true);
      say('Reprise de la même opération et du même import.');
      await status();
    }),
  );
  $('reconcile').addEventListener('click', () =>
    guard(async () => {
      await call({ op: 'reconcile', requestId: state.lastJob.requestId }, true);
      say('Réconciliation de la même opération; une suppression incertaine ne sera pas répétée.');
      await status();
    }),
  );
  $('refresh').addEventListener('click', () =>
    guard(async () => {
      await runs();
      await loadPage();
      await status();
    }),
  );
  $('run').addEventListener('change', () => {
    state.run = $('run').value;
    state.offset = 0;
    state.selected.clear();
    state.plan = null;
    $('confirmation').close();
    guard(loadPage);
  });
  let searchTimer;
  for (const el of [$('search'), $('order')])
    el.addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        state.offset = 0;
        guard(loadPage);
      }, 250);
    });
  $('previous').addEventListener('click', () => {
    state.offset = Math.max(0, state.offset - 24);
    guard(loadPage);
  });
  $('next').addEventListener('click', () => {
    state.offset += 24;
    guard(loadPage);
  });
  $('select-page').addEventListener('click', () => {
    for (const item of state.items) {
      if (state.selected.size >= 100) break;
      if (item.backup && item.phone !== 'deleted' && item.phone !== 'uncertain')
        state.selected.set(item.requestId, item);
    }
    renderItems();
  });
  $('clear').addEventListener('click', () => {
    state.selected.clear();
    renderItems();
  });
  $('prepare').addEventListener('click', () =>
    guard(async () => {
      const run = state.run,
        selection = [...state.selected.keys()].sort();
      if (!selection.length) return;
      $('prepare').disabled = true;
      say('Vérification des copies sur Media…');
      const plan = await call(
        { op: 'prepare', runId: run, items: selection, planId: crypto.randomUUID() },
        true,
      );
      if (
        run !== state.run ||
        JSON.stringify(selection) !== JSON.stringify([...state.selected.keys()].sort())
      )
        throw new Error('La sélection a changé. Vérifie le nouveau lot.');
      state.plan = plan;
      $('plan-summary').textContent =
        `${plan.items.length} fichiers · ${bytes(plan.bytes)} de fichiers sélectionnés. Copies Media revérifiées.`;
      $('plan-files').replaceChildren(...plan.items.map((item) => node('li', item.relativePath)));
      $('confirmation-label').textContent =
        `Pour confirmer cette sélection précise, écris « ${plan.confirmation} ».`;
      $('confirmation-text').value = '';
      $('confirm-delete').disabled = true;
      $('confirmation').showModal();
      $('confirmation-text').focus();
      say('La sélection est prête; aucune suppression avant confirmation.');
    }),
  );
  $('confirmation-text').addEventListener('input', () => {
    $('confirm-delete').disabled = $('confirmation-text').value !== state.plan?.confirmation;
  });
  $('cancel-delete').addEventListener('click', () => {
    $('confirmation').close();
    state.plan = null;
  });
  $('confirm-delete').addEventListener('click', () =>
    guard(async () => {
      const plan = state.plan;
      if (!plan || $('confirmation-text').value !== plan.confirmation) return;
      $('confirm-delete').disabled = true;
      let operation;
      try {
        operation = JSON.parse(sessionStorage.getItem('phone-media.plan.' + plan.planId) || 'null');
      } catch {}
      operation ||= {
        op: 'start',
        kind: 'cleanup',
        requestId: crypto.randomUUID(),
        planId: plan.planId,
        digest: plan.digest,
        confirmation: plan.confirmation,
      };
      sessionStorage.setItem('phone-media.plan.' + plan.planId, JSON.stringify(operation));
      pending(operation);
      try {
        await call(operation, true);
      } catch (e) {
        $('confirm-delete').disabled = false;
        throw e;
      }
      $('confirmation').close();
      state.plan = null;
      state.selected.clear();
      renderItems();
      say('Suppression confirmée enregistrée. Le résultat sera affiché après réception des reçus USB.');
      await status();
    }),
  );
  async function guard(fn) {
    try {
      await fn();
    } catch (e) {
      say(errorMessage(e), true);
    } finally {
      selected();
    }
  }
  let polling = false;
  async function poll() {
    if (polling || document.hidden) return;
    polling = true;
    try {
      await status();
    } catch (e) {
      state.cleanupEnabled = false;
      selected();
      say(errorMessage(e), true);
    } finally {
      polling = false;
    }
  }
  guard(async () => {
    await status();
    await runs();
    await loadPage();
  });
  setInterval(poll, 5000);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) poll();
  });
})();
