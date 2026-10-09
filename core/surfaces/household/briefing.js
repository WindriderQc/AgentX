'use strict';

const { memoryReviewCollectorPosture } = require('./memory-coverage');
const { TASK_ORIGINS, taskOrigin, publicTask, sortedPersonalTasks } = require('../../src/services/personalTaskView');
const { composePersonalBriefing } = require('../../src/services/personalBriefing');
const { catchupProjection } = require('./secretary-catchup');

function boundedText(value, max = 4000) {
  return String(value || '').trim().slice(0, max);
}

function cronItems(cronBody = {}) {
  if (Array.isArray(cronBody)) return cronBody;
  if (Array.isArray(cronBody.data)) return cronBody.data;
  if (Array.isArray(cronBody.data?.jobs)) return cronBody.data.jobs;
  return [];
}

function publicCron(job, now = new Date()) {
  if (!job) return null;
  const lastStatus = boundedText(job.lastRunStatus || job.lastStatus, 32) || 'unknown';
  const lastRunAtMs = Number(job.lastRunAtMs) || 0;
  const everyMs = Number(job.schedule?.everyMs) || 0;
  const fresh = everyMs > 0 ? lastRunAtMs > 0 && now.getTime() - lastRunAtMs <= Math.max(everyMs * 3, 1800000) : true;
  const ageMs = lastRunAtMs > 0 ? Math.max(0, now.getTime() - lastRunAtMs) : null;
  // Two missed cycles is late. One catch-up turn may itself run ten minutes at a
  // five-minute cadence, so nothing is called late before thirty minutes.
  const late = everyMs > 0 && (ageMs === null || ageMs > Math.max(everyMs * 2, 1800000));
  return {
    id: boundedText(job.id, 120),
    name: boundedText(job.name, 120),
    enabled: job.enabled !== false,
    healthy: job.enabled !== false && ['ok', 'success'].includes(lastStatus) && fresh,
    fresh,
    late,
    ageHours: ageMs === null ? null : Math.round(ageMs / 360000) / 10,
    lastStatus,
    lastRunAt: Number(job.lastRunAtMs) > 0 ? new Date(Number(job.lastRunAtMs)).toISOString() : null,
    nextRunAt: Number(job.nextRunAtMs) > 0 ? new Date(Number(job.nextRunAtMs)).toISOString() : null,
    cadenceMinutes: everyMs > 0 ? Math.round(everyMs / 60000) : null
  };
}

function familyDesk(familyBody = {}) {
  const profiles = Array.isArray(familyBody.profiles) ? familyBody.profiles : [];
  const chores = Array.isArray(familyBody.chores) ? familyBody.chores : [];
  const active = chores.filter((chore) => ['queued', 'in_progress', 'review'].includes(chore?.status));
  const waiting = active.filter((chore) => chore?.status === 'review');
  const status = profiles.length === 0
    ? 'setup'
    : active.length === 0
      ? 'needs_routine'
      : waiting.length > 0
        ? 'review'
        : 'ready';
  const summary = status === 'setup'
    ? 'Kids Room is safe and open; add the first family profile and routines when you are ready.'
    : status === 'needs_routine'
      ? `${profiles.length} profile${profiles.length === 1 ? '' : 's'} ready · add the first household routine.`
      : status === 'review'
        ? `${waiting.length} child check-in${waiting.length === 1 ? '' : 's'} waiting for Dad.`
        : `${profiles.length} profile${profiles.length === 1 ? '' : 's'} · ${active.length} active household routine${active.length === 1 ? '' : 's'}.`;
  return {
    status,
    summary,
    profiles: profiles.length,
    routines: active.length,
    waiting: waiting.length,
    href: '/lecture/parents'
  };
}

function dadDesk(reportBody = {}, taskItems = [], cronBody = {}, now = new Date(), familyBody = {}, activationBody = {}, budgetBody = {}, mailBacklogBody = {}, mailCatchupBody = null) {
  const briefing = dadBriefing(reportBody, taskItems, now);
  const tasks = sortedPersonalTasks(taskItems, now).filter((task) => !['done', 'cancelled'].includes(task.status));
  const inbox = tasks.filter((task) => task.unscheduled);
  const stale = inbox.filter((task) => task.stale);
  const weekEnd = new Date(now);
  weekEnd.setDate(weekEnd.getDate() + 7);
  const upcoming = tasks.filter((task) => task.lane === 'upcoming' && new Date(task.dueAt) <= weekEnd);
  const focus = [...tasks.filter((task) => task.overdue), ...tasks.filter((task) => task.dueToday), ...upcoming]
    .filter((task, index, values) => values.findIndex((candidate) => candidate.id === task.id) === index)
    .slice(0, 30);

  const cronUnavailable = cronBody.unavailable === true || Boolean(cronBody.error);
  const jobs = cronItems(cronBody);
  const memoryProvenance = memoryReviewCollectorPosture(cronUnavailable ? [] : jobs);
  const provenanceNeedsAttention = ['attention', 'unavailable'].includes(memoryProvenance.status);
  const provenanceDetail = memoryProvenance.issues[0]?.detail || 'Memory collector provenance is unavailable.';
  const memoryReview = {
    ...briefing.memoryReview,
    queueStatus: briefing.memoryReview.status,
    status: briefing.memoryReview.status === 'unavailable'
      ? 'unavailable'
      : provenanceNeedsAttention
        ? 'attention'
        : briefing.memoryReview.status,
    summary: briefing.memoryReview.status === 'unavailable' || memoryProvenance.status === 'ready'
      ? briefing.memoryReview.summary
      : `${briefing.memoryReview.summary} ${provenanceDetail}`,
    provenance: memoryProvenance
  };
  const findJob = (name) => publicCron(jobs.find((job) => job?.name === name), now);
  const triage = findJob('gmail-oldest-backlog-triage');
  const watchdog = findJob('gmail-secretary-health-watchdog');
  const morning = findJob('morning-briefing');
  const reminderJob = findJob('nestor-personal-morning');
  const reminderStatus = cronUnavailable
    ? 'unavailable'
    : !reminderJob
      ? 'missing'
      : !reminderJob.enabled
        ? 'off'
        : ['ok', 'success'].includes(reminderJob.lastStatus)
          ? 'active'
          : reminderJob.lastStatus === 'unknown' && !reminderJob.lastRunAt
            ? 'pending'
            : 'attention';
  const reminderSummary = reminderStatus === 'off'
    ? 'Installed and off by choice. Review delivery before enabling it.'
    : reminderStatus === 'active'
      ? 'The read-only morning reminder is active.'
      : reminderStatus === 'pending'
        ? 'Enabled; its first run receipt is still pending.'
        : reminderStatus === 'attention'
          ? 'The personal reminder needs an OpenClaw review.'
          : reminderStatus === 'missing'
            ? 'The consent-gated reminder declaration is not installed.'
            : 'Personal reminder evidence is unavailable.';
  const family = familyDesk(familyBody);
  const activationItems = Array.isArray(activationBody.items) ? activationBody.items : [];
  const activationOpen = activationItems.filter((item) => ['waiting', 'attention'].includes(item?.status));
  const budget = budgetBody.data || budgetBody;
  const budgetUnavailable = budgetBody.unavailable === true || Boolean(budgetBody.error);
  const localUsageRatio = Math.max(0, Number(budget.usage_ratio) || 0);
  const cloudRequests = Math.max(0, Number(budget.cloud_requests) || 0);
  const cloudHealth = boundedText(budget.cloud_health, 24) || 'unknown';
  const cloudObservability = boundedText(budget.cloud_spend_observability, 40) || 'unknown';
  const utilization = {
    status: budgetUnavailable ? 'unavailable' : ['yellow', 'red'].includes(cloudHealth) ? 'attention' : 'clear',
    period: boundedText(budget.period, 24) || '24h',
    localRequests: Math.max(0, Number(budget.local_requests) || 0),
    localTokens: Math.max(0, Number(budget.local_tokens) || 0),
    localHealth: boundedText(budget.budget_health, 24) || 'unknown',
    localActivity: localUsageRatio >= 1 ? 'high' : localUsageRatio >= 0.7 ? 'active' : 'light',
    localUsageRatio,
    cloudRequests,
    cloudTokens: Math.max(0, Number(budget.cloud_tokens) || 0),
    cloudHealth,
    cloudObservability,
    attributionMissing: cloudRequests > 0 && ['none-recorded', 'unknown'].includes(cloudObservability),
    href: '/analytics'
  };
  const mailReady = !cronUnavailable && triage?.healthy === true && watchdog?.healthy === true;
  // A stopped triage is not a nuance: it left three days of mail unlabelled in
  // September 2026 while this block only said "check".
  const triageStopped = !cronUnavailable && (!triage || !triage.enabled || triage.late);
  const mailStatus = cronUnavailable ? 'unavailable' : triageStopped ? 'stopped' : mailReady ? 'ready' : 'attention';
  const backlogKnown = Number.isInteger(mailBacklogBody.unlabelled) && !mailBacklogBody.error;
  const backlog = backlogKnown
    ? {
        unlabelled: mailBacklogBody.unlabelled,
        capped: mailBacklogBody.capped === true,
        days: Number(mailBacklogBody.days) || 7,
        checkedAt: boundedText(mailBacklogBody.checkedAt, 40) || null
      }
    : { unlabelled: null, capped: false, days: 7, checkedAt: null, error: boundedText(mailBacklogBody.error, 200) || 'The unlabelled count is unavailable.' };
  const triageAge = !triage
    ? 'La tâche de tri Gmail est absente d’OpenClaw.'
    : !triage.enabled
      ? `Le tri Gmail est désactivé${triage.ageHours === null ? '' : ` · dernier passage il y a ${triage.ageHours} h`}.`
      : `Dernier tri Gmail : ${triage.ageHours === null ? 'jamais' : `il y a ${triage.ageHours} h`}${triage.cadenceMinutes ? ` · attendu toutes les ${triage.cadenceMinutes} min` : ''}.`;
  const mailSummary = cronUnavailable
    ? 'L’état du Secretary Gmail est indisponible.'
    : triageStopped
      ? triageAge
      : mailReady
        ? `Le tri Gmail et sa surveillance fonctionnent${triage.cadenceMinutes ? ` · rattrapage toutes les ${triage.cadenceMinutes} min` : ''}.`
        : 'Le tri Gmail ou sa surveillance est à vérifier.';
  const decisions = [
    ...(stale.length ? [{ id: 'schedule-stale', audience: 'dad', severity: 'warning', title: `${stale.length} ${stale.length === 1 ? 'tâche attend' : 'tâches attendent'} une date depuis longtemps`, detail: 'Donnez-lui une date, terminez-la, ou laissez-la sans date volontairement.', href: '#dad-inbox' }] : []),
    ...(tasks.some((task) => task.expired) ? [{ id: 'expired', audience: 'dad', severity: 'info', title: `${tasks.filter((task) => task.expired).length} ${tasks.filter((task) => task.expired).length === 1 ? 'tâche dont l’activité est passée' : 'tâches dont l’activité est passée'}`, detail: 'L’activité qu’elle servait est passée : fermez-la.', href: '#dad-triage' }] : []),
    ...(tasks.some((task) => task.recheck) ? [{ id: 'recheck', audience: 'dad', severity: 'info', title: `${tasks.filter((task) => task.recheck).length} ${tasks.filter((task) => task.recheck).length === 1 ? 'vieille échéance' : 'vieilles échéances'} à confirmer`, detail: 'Capturée en retard ou en retard depuis des semaines : fermez-la, ou donnez-lui la date de son activité.', href: '#dad-triage' }] : []),
    ...(tasks.some((task) => task.overdue) ? [{ id: 'overdue', audience: 'dad', severity: 'warning', title: `${tasks.filter((task) => task.overdue).length} ${tasks.filter((task) => task.overdue).length === 1 ? 'tâche en retard' : 'tâches en retard'}`, detail: 'Terminez-la ou replanifiez-la ; le bureau ne déplace jamais une échéance en silence.', href: '#dad-focus' }] : []),
    ...(triageStopped ? [{ id: 'mail-triage', audience: 'dad', severity: 'warning', title: 'Le tri Gmail est arrêté', detail: `${triageAge}${backlog.unlabelled ? ` ${backlog.unlabelled}${backlog.capped ? '+' : ''} courriels récents de la boîte de réception sont sans étiquette.` : ''}`, href: '#dad-mail' }] : []),
    ...(family.status === 'review' ? [{ id: 'family-review', audience: 'dad', severity: 'warning', title: 'Revoir les suivis des enfants', detail: family.summary, href: family.href }] : []),
    ...(memoryReview.queueStatus === 'pending' ? [{ id: 'memory-review', audience: 'dad', severity: 'info', title: `${memoryReview.pending} ${memoryReview.pending === 1 ? 'proposition de mémoire en attente' : 'propositions de mémoire en attente'}`, detail: 'Revoyez chaque proposition une à une ; rien n’est promu en silence.', href: '/memory-review' }] : []),
    ...(activationOpen.length ? [{ id: 'household-activation', audience: 'dad', severity: activationOpen.some((item) => item.status === 'attention') ? 'warning' : 'info', title: `${activationOpen.length} ${activationOpen.length === 1 ? 'étape de mise en service attend' : 'étapes de mise en service attendent'} votre décision`, detail: activationOpen.slice(0, 3).map((item) => boundedText(item.label, 80)).filter(Boolean).join(' · '), href: activationOpen[0]?.href || '/dad' }] : []),
    ...(['yellow', 'red'].includes(cloudHealth) ? [{ id: 'cloud-budget', audience: 'dad', severity: 'warning', title: cloudHealth === 'red' ? 'Le budget LLM cloud demande votre attention' : 'Le budget LLM cloud approche de sa limite', detail: `${cloudRequests} ${cloudRequests === 1 ? 'appel cloud attribué' : 'appels cloud attribués'} sur ${utilization.period}.`, href: '/analytics' }] : [])
  ].slice(0, 6);

  return {
    generatedAt: new Date(now).toISOString(),
    status: decisions.length ? 'attention' : 'clear',
    headline: focus.length
      ? `${focus.length} en focus · ${inbox.length} sans date.`
      : inbox.length
        ? `Rien de planifié · ${inbox.length} sans date.`
        : 'Votre liste personnelle est vide.',
    focus,
    inbox: inbox.slice(0, 12),
    upcoming: upcoming.slice(0, 8),
    metrics: {
      open: tasks.length,
      today: tasks.filter((task) => task.dueToday).length,
      overdue: tasks.filter((task) => task.overdue).length,
      inbox: inbox.length,
      stale: stale.length
    },
    mail: {
      status: mailStatus,
      summary: mailSummary,
      triage,
      watchdog,
      morning,
      backlog,
      catchup: catchupProjection(mailCatchupBody),
      authority: 'The OpenClaw secretary agent owns Gmail; every send and destructive mutation remains approval-gated.'
    },
    reminder: {
      status: reminderStatus,
      summary: reminderSummary,
      job: reminderJob,
      schedule: '07:30 America/Toronto',
      consent: reminderJob?.enabled
        ? 'Enabled by Dad for the explicit OpenClaw delivery target.'
        : 'Disabled until Dad explicitly enables delivery in OpenClaw.',
      href: '/api/openclaw/control-launch/cron',
      preview: morningReminderPreview(taskItems, now)
    },
    family,
    utilization,
    operations: briefing.operations,
    memoryReview,
    decisions,
    actions: decisions
  };
}

function morningReminderPreview(taskItems = [], now = new Date()) {
  const brief = composePersonalBriefing(sortedPersonalTasks(taskItems, now), now);
  return {
    status: 'preview-only',
    generatedAt: brief.generatedAt,
    message: brief.text,
    lines: brief.lines,
    counts: brief.counts,
    contract: {
      language: 'fr',
      maximumLines: 6,
      composer: 'core personal_briefing',
      delivery: 'none',
      mutations: 'none'
    },
    note: 'The OpenClaw morning job relays this same Core brief.'
  };
}

function dadBriefing(reportBody = {}, taskItems = [], now = new Date()) {
  const report = reportBody.data || reportBody;
  const reportUnavailable = reportBody.unavailable === true || Boolean(reportBody.error);
  const alerts = report.alerts || {};
  const memoryReview = report.memoryReview || {};
  const tasks = sortedPersonalTasks(taskItems, now);
  const overdue = tasks.filter((task) => task.overdue);
  const dueToday = tasks.filter((task) => task.dueToday);
  const priorities = [...overdue, ...dueToday, ...tasks.filter((task) => !task.overdue && !task.dueToday)]
    .filter((task, index, values) => values.findIndex((candidate) => candidate.id === task.id) === index)
    .slice(0, 3);
  const critical = Math.max(0, Number(alerts.critical) || 0);
  const warning = Math.max(0, Number(alerts.warning) || 0);
  const activeAlerts = Math.max(0, Number(alerts.active) || critical + warning);
  const pendingMemory = Math.max(0, Number(memoryReview.pending) || 0);
  const memoryAttention = memoryReview.attention === true || memoryReview.activeRun?.reconciliation?.overdue === true;
  const needsAttention = reportUnavailable || overdue.length > 0 || critical > 0 || warning > 0 || pendingMemory > 0 || memoryAttention;
  const recentAlert = Array.isArray(alerts.recent) && alerts.recent[0] && typeof alerts.recent[0] === 'object'
    ? boundedText(alerts.recent[0].title || alerts.recent[0].message, 180)
    : '';
  const taskSummary = tasks.length === 0
    ? 'Your personal list is clear.'
    : `${tasks.length} open personal task${tasks.length === 1 ? '' : 's'} · ${dueToday.length} due today · ${overdue.length} overdue.`;
  const opsSummary = reportUnavailable
    ? 'Ecosystem morning report is unavailable.'
    : critical > 0
      ? `${critical} critical ecosystem alert${critical === 1 ? '' : 's'}${recentAlert ? ` · ${recentAlert}` : ''}`
      : warning > 0
        ? `${warning} ecosystem warning${warning === 1 ? '' : 's'}${recentAlert ? ` · ${recentAlert}` : ''}`
        : activeAlerts > 0
          ? `${activeAlerts} active ecosystem alert${activeAlerts === 1 ? '' : 's'}`
          : 'Ecosystem reports all clear.';
  return {
    generatedAt: new Date(now).toISOString(),
    status: needsAttention ? 'attention' : 'clear',
    headline: taskSummary,
    priorities,
    tasks: {
      open: tasks.length,
      dueToday: dueToday.length,
      overdue: overdue.length
    },
    operations: {
      status: reportUnavailable ? 'unavailable' : critical > 0 ? 'critical' : warning > 0 || activeAlerts > 0 ? 'warning' : 'clear',
      activeAlerts,
      critical,
      warning,
      summary: opsSummary,
      href: '/agent-ops'
    },
    memoryReview: {
      status: reportUnavailable ? 'unavailable' : memoryAttention ? 'attention' : pendingMemory > 0 ? 'pending' : 'clear',
      pending: pendingMemory,
      runId: boundedText(memoryReview.runId, 120) || null,
      summary: reportUnavailable
        ? 'Dreaming Review status is unavailable.'
        : memoryAttention
          ? 'Dreaming Review reconciliation needs attention.'
          : pendingMemory > 0
            ? `${pendingMemory} memory proposal${pendingMemory === 1 ? '' : 's'} waiting for individual review.`
            : 'No memory proposals are waiting for review.',
      href: '/memory-review'
    }
  };
}

module.exports = { TASK_ORIGINS, dadBriefing, dadDesk, familyDesk, morningReminderPreview, publicTask, sortedPersonalTasks, taskOrigin };
